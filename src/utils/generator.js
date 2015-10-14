/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { Realm } from "../realm.js";
import { AbstractValue, Value, FunctionValue, UndefinedValue, NullValue, StringValue, BooleanValue, NumberValue, SymbolValue, ObjectValue } from "../values/index.js";
import type { Descriptor } from "../types.js";
import { TypesDomain, ValuesDomain } from "../domains/index.js";
import * as base62 from "base62";
import * as t from "babel-types";
import invariant from "../invariant.js";
import type { BabelNodeExpression, BabelNodeIdentifier, BabelNodeStatement, BabelNodeMemberExpression } from "babel-types";

export type BodyEntry = {
  declaresDerivedId?: BabelNodeIdentifier;
  args: Array<Value>;
  buildNode: (Array<BabelNodeExpression>, Value => BabelNodeExpression) => BabelNodeStatement;
}

export class Generator {
  constructor(realm: Realm) {
    invariant(realm.isPartial);
    let realmPreludeGenerator = realm.preludeGenerator;
    invariant(realmPreludeGenerator);
    this.preludeGenerator = realmPreludeGenerator;
    this.realm = realm;
    this.body = [];
  }

  realm: Realm;
  body: Array<BodyEntry>;
  preludeGenerator: PreludeGenerator;

  empty() {
    return !this.body.length;
  }

  emitGlobalDeclaration(key: string, value: Value) {
    this.body.push({
      args: [value],
      buildNode: ([valueNode]) => t.variableDeclaration("var", [
        t.variableDeclarator(t.identifier(key), valueNode)
      ])
    });
  }

  emitGlobalAssignment(key: string, value: Value) {
    this.body.push({
      args: [value],
      buildNode: ([valueNode]) => t.expressionStatement(t.assignmentExpression(
        "=",
        t.identifier(key),
        valueNode))
    });
  }

  emitGlobalDelete(key: string) {
    this.body.push({
      args: [],
      buildNode: ([]) => t.expressionStatement(t.unaryExpression(
        "delete",
        t.identifier(key)))
    });
  }

  emitPropertyAssignment(object: Value, key: string, value: Value) {
    this.body.push({
      args: [object, value],
      buildNode: ([objectNode, valueNode]) => t.expressionStatement(t.assignmentExpression(
        "=",
        t.memberExpression(objectNode, t.identifier(key)),
        valueNode))
    });
  }

  emitDefineProperty(object: Value, key: string, desc: Descriptor) {
    if (desc.enumerable && desc.configurable && desc.writable && desc.value) {
      let descValue = desc.value;
      invariant(descValue instanceof Value);
      this.emitPropertyAssignment(object, key, descValue);
    } else {
      desc = Object.assign({}, desc);
      this.body.push({
        args: [object, desc.value || object.$Realm.intrinsics.undefined, desc.get || object.$Realm.intrinsics.undefined, desc.set || object.$Realm.intrinsics.undefined],
        buildNode: ([objectNode, valueNode, getNode, setNode]) => {
          let descProps = [];
          descProps.push(t.objectProperty(t.identifier("enumerable"), t.booleanLiteral(!!desc.enumerable)));
          descProps.push(t.objectProperty(t.identifier("configurable"), t.booleanLiteral(!!desc.configurable)));
          if (!desc.get && !desc.set) {
            descProps.push(t.objectProperty(t.identifier("writable"), t.booleanLiteral(!!desc.writable)));
            descProps.push(t.objectProperty(t.identifier("value"), valueNode));
          } else {
            descProps.push(t.objectProperty(t.identifier("get"), getNode));
            descProps.push(t.objectProperty(t.identifier("set"), setNode));
          }
          return t.expressionStatement(t.callExpression(
            this.preludeGenerator.memoiseReference("Object.defineProperty"),
            [objectNode, t.stringLiteral(key), t.objectExpression(descProps)]
          ));
        }
      });
    }
  }

  emitPropertyDelete(object: Value, key: string) {
    this.body.push({
      args: [object],
      buildNode: ([objectNode]) => t.expressionStatement(t.unaryExpression(
        "delete",
        t.memberExpression(objectNode, t.identifier(key))))
    });
  }

  emitConsoleLog(str: string) {
    let strn = new StringValue(this.realm, str);
    this.body.push({
      args: [strn],
      buildNode: ([strVal]) => t.expressionStatement(
        t.callExpression(t.memberExpression(t.identifier("console"), t.identifier("log")), [strVal]))
    });
  }

  // Pushes "if (violationConditionFn()) { throw new Error("invariant violation"); }"
  emitInvariant(args: Array<Value>, violationConditionFn: (Array<BabelNodeExpression> => BabelNodeExpression)): void {
    this.body.push({
      args,
      buildNode: (nodes: Array<BabelNodeExpression>) => {
        let condition = violationConditionFn(nodes);
        let throwblock = t.blockStatement([
          t.throwStatement(
            t.newExpression(
              t.identifier("Error"),
              [t.stringLiteral("Prepack model invariant violation")]))
          ]);
        return t.ifStatement(condition, throwblock);
      } });
  }

  derive(types: TypesDomain, values: ValuesDomain, args: Array<Value>, buildNode_: (Array<BabelNodeExpression> => BabelNodeExpression) | BabelNodeExpression, kind?: string): AbstractValue {
    invariant(buildNode_ instanceof Function || args.length === 0);
    let id = t.identifier(this.preludeGenerator.generateUid());
    this.preludeGenerator.derivedIds.add(id);
    this.body.push({
      declaresDerivedId: id,
      args,
      buildNode: (nodes: Array<BabelNodeExpression>) => t.variableDeclaration("var", [
        t.variableDeclarator(id, (buildNode_: any) instanceof Function ? ((buildNode_: any): (Array<BabelNodeExpression> => BabelNodeExpression))(nodes) : ((buildNode_: any): BabelNodeExpression))
      ])
    });
    let res = this.realm.createAbstract(types, values, args, id, kind);
    let type = types.getType();
    res.intrinsicName = id.name;
    let typeofString;
    if (type === FunctionValue) typeofString = "function";
    else if (type === UndefinedValue) invariant(false);
    else if (type === NullValue) invariant(false);
    else if (type === StringValue) typeofString = "string";
    else if (type === BooleanValue) typeofString = "boolean";
    else if (type === NumberValue) typeofString = "number";
    else if (type === SymbolValue) typeofString = "symbol";
    else if (type === ObjectValue) typeofString = "object";
    if (typeofString !== undefined) {
      // Verify that the types are as expected, a failure of this invariant
      // should mean the model is wrong.
      this.emitInvariant(
        [res],
        (nodes) => {
          invariant(typeofString !== undefined);
          let condition =
            t.binaryExpression("!==",
              t.unaryExpression("typeof", nodes[0]), t.stringLiteral(typeofString));
          if (typeofString === "object")
            condition =
              t.logicalExpression("||", condition,
                t.binaryExpression("===", nodes[0], t.nullLiteral()));
          return condition;
        });
    }

    return res;
  }
}

function copyPG (from: PreludeGenerator, to: PreludeGenerator) {
  to.prelude = from.prelude.slice(0);
  to.derivedIds = new Set(from.derivedIds);
  to.memoisedRefs = new Map(from.memoisedRefs);
  to.uidCounter = from.uidCounter;
}

export class PreludeGenerator {
  constructor() {
    this.prelude = [];
    this.derivedIds = new Set();
    this.memoisedRefs = new Map();
    this.uidCounter = 0;
  }

  prelude: Array<BabelNodeStatement>;
  derivedIds: Set<BabelNodeIdentifier>;
  memoisedRefs: Map<string, BabelNodeIdentifier | BabelNodeMemberExpression>;
  uidCounter: number;

  convertStringToMember(str: string): BabelNodeIdentifier | BabelNodeMemberExpression {
    return str
      .split(".")
      .map((name) => t.identifier(name))
      .reduce((obj, prop) => t.memberExpression(obj, prop));
  }

  generateUid(): string {
    let id = "_" + base62.encode(this.uidCounter++);
    return id;
  }

  memoiseReference(key: string): BabelNodeIdentifier | BabelNodeMemberExpression {
    let ref = this.memoisedRefs.get(key);
    if (ref) return ref;

    ref = t.identifier(this.generateUid());
    this.prelude.push(t.variableDeclaration("var", [
      t.variableDeclarator(ref, this.convertStringToMember(key))
    ]));
    this.memoisedRefs.set(key, ref);
    return ref;
  }

  save(): PreludeGenerator {
    let saved = new PreludeGenerator();
    copyPG(this, saved);
    return saved;
  }

  restore(saved: PreludeGenerator) {
    copyPG(saved, this);
  }

}
