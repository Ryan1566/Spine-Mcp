// 骨骼世界变换的最小内核。pose-eval（采样线框）和 constraints（约束求解）都用这一份，
// 避免两处各写一遍矩阵乘法后走样。
//
// 3.8 的语义（已用真实渲染反向验证，见 tests/p15-pose.test.mjs）：
//   rotationY = rotation + 90 + shearY
//   la = cos(rotation + shearX) * scaleX
//   lb = cos(rotationY) * scaleY
//   lc = sin(rotation + shearX) * scaleX
//   ld = sin(rotationY) * scaleY
// 父级累乘：a = parent.a*la + parent.b*lc，x = parent.x + local.x*parent.a + local.y*parent.b
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

const round4 = (n) => Math.round(n * 10000) / 10000;
const round6 = (n) => Math.round(n * 1000000) / 1000000;

export function localMatrix(local) {
  const rotationY = local.rotation + 90 + local.shearY;
  return {
    la: Math.cos((local.rotation + local.shearX) * DEG) * local.scaleX,
    lb: Math.cos(rotationY * DEG) * local.scaleY,
    lc: Math.sin((local.rotation + local.shearX) * DEG) * local.scaleX,
    ld: Math.sin(rotationY * DEG) * local.scaleY,
  };
}

// 父级世界矩阵 + 局部变换 → 本骨世界矩阵（未取整，便于约束求解继续用）
export function composeWorld(parent, local) {
  const { la, lb, lc, ld } = localMatrix(local);
  if (!parent) return { a: la, b: lb, c: lc, d: ld, x: local.x, y: local.y };
  return {
    a: parent.a * la + parent.b * lc,
    b: parent.a * lb + parent.b * ld,
    c: parent.c * la + parent.d * lc,
    d: parent.c * lb + parent.d * ld,
    x: parent.x + local.x * parent.a + local.y * parent.b,
    y: parent.y + local.x * parent.c + local.y * parent.d,
  };
}

// 骨骼世界朝向（x 轴方向角，度）
export function worldRotation(matrix) {
  return Math.atan2(matrix.c, matrix.a) * RAD;
}

// 骨骼世界长度（沿自身 x 轴，含所有父级缩放）
export function worldScaleX(matrix) {
  return Math.hypot(matrix.a, matrix.c);
}

// 骨骼世界 y 轴长度（含所有父级缩放）
export function worldScaleY(matrix) {
  return Math.hypot(matrix.b, matrix.d);
}

// 骨骼世界剪切（度）：Y 轴角 - X 轴角 - 90。无剪切时恒为 0。
export function worldShearY(matrix) {
  const angleX = Math.atan2(matrix.c, matrix.a) * RAD;
  const angleY = Math.atan2(matrix.d, matrix.b) * RAD;
  let shear = (angleY - angleX - 90) % 360;
  if (shear > 180) shear -= 360;
  if (shear <= -180) shear += 360;
  return shear;
}

// 归一化到 (-180, 180]
export function wrapDeg(angle) {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

export function boneEndPoint(bone) {
  const length = bone.length ?? 0;
  return { x: bone.x + length * bone.a, y: bone.y + length * bone.c };
}

// 骨骼名 -> 下标，以及下标 -> 子级下标列表
export function buildBoneIndex(skeleton) {
  const bones = skeleton?.bones ?? [];
  const indexByName = new Map();
  const children = bones.map(() => []);
  for (const [i, b] of bones.entries()) {
    if (b?.name != null) indexByName.set(b.name, i);
  }
  for (const [i, b] of bones.entries()) {
    const parent = resolveParentIndex(b, indexByName, bones.length);
    if (parent != null && parent !== i) children[parent].push(i);
  }
  return { bones, indexByName, children };
}

export function resolveParentIndex(bone, indexByName, boneCount) {
  if (bone?.parent == null) return null;
  // 3.8 JSON 的 parent 是名字字符串；夹具/旧数据里也可能是下标
  const pi = typeof bone.parent === 'number' ? bone.parent : indexByName.get(bone.parent);
  if (pi == null || pi < 0 || pi >= boneCount || pi < 0) return null;
  return pi;
}

// 重算某根骨骼及其整棵子树的世界矩阵（约束改完局部值后必须走这一步，
// 否则子级的 world 还是旧的，线框会“骨头动了肉没动”）。
export function recomputeSubtree(skeleton, pose, world, startIndex, index = null) {
  const built = index ?? buildBoneIndex(skeleton);
  const { bones, children, indexByName } = built;
  const visit = (i, parentWorld) => {
    const data = bones[i];
    const local = pose?.[i] ?? { rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inherit: 'normal' };
    const m = composeWorld(parentWorld, local);
    const out = world[i] ?? {};
    out.name = data?.name;
    out.index = i;
    out.length = data?.length ?? 0;
    out.a = round6(m.a);
    out.b = round6(m.b);
    out.c = round6(m.c);
    out.d = round6(m.d);
    out.x = round6(m.x);
    out.y = round6(m.y);
    out.local = {
      rotation: round4(local.rotation),
      x: round4(local.x),
      y: round4(local.y),
      scaleX: round4(local.scaleX),
      scaleY: round4(local.scaleY),
      shearX: round4(local.shearX),
      shearY: round4(local.shearY),
    };
    world[i] = out;
    for (const c of children[i]) visit(c, m);
    return out;
  };
  const parentIndex = resolveParentIndex(bones[startIndex], indexByName, bones.length);
  const parentWorld = parentIndex == null ? null : world[parentIndex] ?? null;
  // world 里存的是取整值；这里为了子级累乘精度，尽量用未取整的矩阵
  const parentMatrix = parentWorld ? { a: parentWorld.a, b: parentWorld.b, c: parentWorld.c, d: parentWorld.d, x: parentWorld.x, y: parentWorld.y } : null;
  visit(startIndex, parentMatrix);
  return world;
}
