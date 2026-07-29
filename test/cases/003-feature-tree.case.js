export default async function featureTreeCase({ assert, kernel }) {
  const resized = await kernel("plate", {
    params: {
      width: 120,
      depth: 50,
      thickness: 20,
      holeDiameter: 6,
      filletRadius: 0,
    },
  });
  assert.near(resized.volume, 117738.053, 0.5, "改宽度后整链重算体积");

  const chamfered = await kernel("plate", {
    params: {
      width: 100,
      depth: 50,
      thickness: 20,
      holeDiameter: 6,
      filletRadius: 0,
      chamferSize: 2,
    },
  });
  const chamferCuts = chamfered.featureMetrics.filter(
    (feature) => feature.type === "cut",
  );
  const beforeChamfer = chamferCuts.at(-1);
  const afterChamfer = chamfered.featureMetrics.at(-1);
  assert.greater(
    beforeChamfer.volume - afterChamfer.volume,
    0,
    "倒角减少体积",
  );
  assert.greater(
    afterChamfer.faceCount - beforeChamfer.faceCount,
    0,
    "倒角增加面数",
  );

  const revolved = await kernel("recompute", {
    tree: {
      version: 1,
      unit: "mm",
      sketches: {
        profile: {
          id: "profile",
          type: "polygon",
          points: [
            [10, 0],
            [20, 0],
            [20, 10],
            [10, 10],
          ],
        },
      },
      features: [
        {
          id: "revolve-1",
          type: "revolve",
          sketchId: "profile",
          plane: "XZ",
          axis: [0, 0, 1],
          origin: [0, 0, 0],
          angle: 360,
        },
      ],
    },
  });
  assert.near(revolved.volume, 3000 * Math.PI, 0.5, "旋转特征体积");
  assert.equal(revolved.nakedEdgeCount, 0, "旋转特征网格裸边数");
}
