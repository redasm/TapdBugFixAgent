// View/controller boundary only; does not assert network-ordering guarantees.
export default async ({ test, assert, loadMembers }) => {
  const file = 'TypeScript/Src/Game/Module/RecruitBoard/View/RecruitMinePanel.ts';
  for (const accept of [false, true]) for (const team of [false, true]) {
    await test(`reply-${accept}-${team}`, 'reproduction', () => {
      const events = [];
      let response;
      const request = (...args) => { events.push('request'); assert.equal(args[0], accept); response = args.at(-1); };
      const panel = loadMembers(file, 'RecruitMinePanel', ['OnApplicantReply'], {
        RecruitBoardUtil: { IsRecruitTeamIdentityValid: () => true }, MathUtils: { LongToNumber: Number },
        ModelManager: { RecruitBoardModel: { RecruitInfoData: { RecruitInfo: { teamIdentity: 'own' } } } },
        ControllerHolder: { RecruitBoardController: { RequestReplyJoinTeamByTeam: request, RequestReplyJoinTeamByUid: request } },
      });
      panel.ApplicantList = { GetItemByKey: id => { assert.equal(id, 42); return { SetUIActive: active => events.push(active ? 'show' : 'hide') }; } };
      panel.RefreshApplyList = () => events.push('refresh-authoritative-data');
      panel.OnApplicantReply(accept, { LeaderInfo: { uid: 42 }, ...(team ? { TeamIdentity: 'other' } : {}) });
      assert.deepEqual(events, ['hide', 'request']);
      response();
      assert.deepEqual(events, ['hide', 'request', 'refresh-authoritative-data']);
    });
  }
  await test('invalid-team-does-nothing', 'regression', () => {
    const panel = loadMembers(file, 'RecruitMinePanel', ['OnApplicantReply'], { RecruitBoardUtil: { IsRecruitTeamIdentityValid: () => false } });
    panel.OnApplicantReply(true, {});
  });
};
