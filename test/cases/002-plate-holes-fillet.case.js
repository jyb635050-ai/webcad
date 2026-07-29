export default async function plateHolesFilletCase({ assert, kernel }) {
  const result = await kernel("plate", {
    params: {
      width: 100,
      depth: 50,
      thickness: 20,
      holeDiameter: 6,
      filletRadius: 5,
    },
  });

  const cuts = result.featureMetrics.filter((feature) => feature.type === "cut");
  const beforeFillet = cuts.at(-1);
  const afterFillet = result.featureMetrics.at(-1);

  assert.near(beforeFillet.volume, 97738.053, 0.5, "四孔板圆角前体积");
  assert.greater(beforeFillet.volume - afterFillet.volume, 0, "R5圆角减少体积");
  assert.greater(
    afterFillet.faceCount - beforeFillet.faceCount,
    0,
    "R5圆角增加面数",
  );
  assert.equal(result.nakedEdgeCount, 0, "圆角后网格裸边数");
  assert.equal(result.nonManifoldEdgeCount, 0, "圆角后非流形边数");
  assert.equal(result.degenerateTriangleCount, 0, "圆角后退化三角形数");
  assert.greater(result.triangleCount, 12, "圆角后网格三角形数");
}
