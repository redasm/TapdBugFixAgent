// Project regression expectations from case-08. Uses current source, not copied implementation.
export default async ({ test, assert, loadMembers }) => {
  const file = 'TypeScript/Src/Game/Module/LevelMap/Controller/LevelMapController.ts';
  const subject = tiles => loadMembers(file, 'LevelMapController', ['CheckLevelCanOpen'], {
    ConfigManager: { MapConfig: { GetAllTileConfig: () => tiles } },
  });
  await test('world-map-without-tiles', 'reproduction', () => assert.equal(subject([]).CheckLevelCanOpen(10), false));
  await test('tiles-missing', 'regression', () => assert.equal(subject(undefined).CheckLevelCanOpen(10), false));
  await test('tiles-present', 'regression', () => assert.equal(subject([{}]).CheckLevelCanOpen(10), true));
  await test('invalid-level', 'regression', () => assert.equal(subject([{}]).CheckLevelCanOpen(0), false));
};
