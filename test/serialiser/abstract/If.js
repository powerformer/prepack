let x = global.__abstract ? __abstract("boolean", "true") : true;
let y = 1;
let yy = 2;
let ob = { a: 1, b: 2 };
a = 10;
if (x) {
  y = 2;
  a = 20;
  ob.a = 10;
  ob.b = 20;
} else {
  y = 3;
  yy = 6;
  a = 30;
  ob.b = 40;
}
z = y;
z1 = yy;
z2 = ob.a;
z3 = ob.b;
inspect = function() { return "" +  a + z + z1 + z2 + z3; }
