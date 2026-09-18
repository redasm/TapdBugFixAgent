export default async ({ test, assert, loadMembers }) => {
  const file = 'TypeScript/Src/Game/Module/LevelMap/SubViews/CustomMarkHandleView.ts';
  for (const markExists of [false, true]) {
    await test(`restore-secondary-state-${markExists}`, markExists ? 'regression' : 'reproduction', () => {
      const emitted = [];
      const view = loadMembers(file, 'CustomMarkHandleView', ['OnBeforeDestroy'], {
        ObjectUtils: { IsValid: () => false }, ECustomMarkPanelMode: { Modify: 1 },
        EEventName: { LevelMapSecondaryUiActive: 'secondary-active' }, EventSystem: { Emit: (...args) => emitted.push(args) },
      });
      view.CustomPanelMode = 1;
      view.ClickedCustomMark = markExists ? {} : undefined;
      view.OnBeforeDestroy();
      assert.deepEqual(emitted, [['secondary-active', false]]);
    });
  }
};
