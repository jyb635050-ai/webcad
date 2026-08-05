export default async function sideFacePolygonCutCase({ assert, kernel }) {
  const makeTree = (cutFeature) => ({
    version: 2,
    unit: "mm",
    sketches: {
      base: {
        id: "base",
        type: "rectangle",
        plane: "XY",
        origin: [0, 0],
        width: 20,
        height: 20,
      },
      sideTriangle: {
        id: "sideTriangle",
        type: "polygon",
        plane: "XZ",
        points: [
          [5, 20],
          [15, 20],
          [10, 40],
        ],
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
        distance: 60,
        operation: "base",
      },
      {
        id: "cut-1",
        type: "cut",
        sketchId: "sideTriangle",
        plane: "XZ",
        offset: 0,
        direction: 1,
        ...cutFeature,
      },
    ],
  });

  const baseVolume = 20 * 20 * 60;
  const triangleArea = (10 * 20) / 2;

  const blind = await kernel("recompute", {
    tree: makeTree({ distance: 5, throughAll: false }),
  });
  assert.near(
    blind.volume,
    baseVolume - triangleArea * 5,
    0.02,
    "XZ前侧面三角形盲切体积",
  );
  assert.equal(blind.nakedEdgeCount, 0, "XZ前侧面三角形盲切裸边数");
  assert.equal(blind.featureMetrics.length, 2, "XZ前侧面三角形盲切特征数");

  const through = await kernel("recompute", {
    tree: makeTree({ distance: 1, throughAll: true }),
  });
  assert.near(
    through.volume,
    baseVolume - triangleArea * 20,
    0.02,
    "XZ前侧面三角形贯穿切除体积",
  );
  assert.equal(through.nakedEdgeCount, 0, "XZ前侧面三角形贯穿切除裸边数");
  assert.greater(through.triangleCount, 12, "XZ前侧面三角形贯穿切除三角形数");
}
