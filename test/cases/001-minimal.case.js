export default async function minimalCase({ assert, kernel }) {
  const result = await kernel("minimal");
  assert.near(result.volume, 6000, 0.000001, "10×20×30箱体体积");
  assert.equal(result.faceCount, 6, "箱体面数");
  assert.equal(result.triangleCount, 12, "箱体网格三角形数");
  assert.equal(result.stlBytes, 684, "二进制STL字节数");
}
