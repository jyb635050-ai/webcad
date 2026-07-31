export default async function sideFaceCutCase({ assert, kernel }) {
  const makeTree = (cutFeature) => ({
    version: 2,
    unit: "mm",
    sketches: {
      base: {
        id: "base",
        type: "rectangle",
        plane: "XY",
        origin: [0, 0],
        width: 80,
        height: 40,
      },
      sideHole: {
        id: "sideHole",
        type: "circle",
        plane: "XZ",
        center: [40, 10],
        radius: 5,
      },
    },
    features: [
      {
        id: "extrude-1",
        type: "extrude",
        sketchId: "base",
        plane: "XY",
        offset: 0,
        direction: 1,
        distance: 20,
        operation: "base",
      },
      {
        id: "cut-1",
        type: "cut",
        sketchId: "sideHole",
        plane: "XZ",
        ...cutFeature,
      },
    ],
  });

  const blind = await kernel("recompute", {
    tree: makeTree({
      offset: 40,
      direction: -1,
      distance: 10,
      throughAll: false,
    }),
  });
  assert.near(
    blind.volume,
    80 * 40 * 20 - Math.PI * 5 ** 2 * 10,
    0.02,
    "XZ侧面φ10深10切除体积",
  );
  assert.equal(blind.nakedEdgeCount, 0, "XZ侧面盲孔网格裸边数");
  assert.equal(blind.featureMetrics.length, 2, "XZ侧面盲孔特征数");

  const through = await kernel("recompute", {
    tree: makeTree({
      offset: 40,
      direction: -1,
      distance: 1,
      throughAll: true,
    }),
  });
  assert.near(
    through.volume,
    80 * 40 * 20 - Math.PI * 5 ** 2 * 40,
    0.02,
    "XZ侧面φ10贯穿切除体积",
  );
  assert.equal(through.nakedEdgeCount, 0, "XZ侧面贯穿孔网格裸边数");
  assert.greater(through.triangleCount, 12, "XZ侧面贯穿孔三角形数");
}