const assert = require('assert/strict');
const guard = require('../../../services/judgeSandbox/offlineGuard.service');
const { Notification } = require('../../../models/Notification');
let writes = [], nudges = [], emails = 0;
Notification.create = async row => { writes.push(row);return { ...row, _id: 'notice' }; };
require('../../../services/notification/email.service').sendEmail = async () => { emails++;throw Error('must not call any email helper'); };
require('../../../services/realtime/liveEvents.service').publish = (...args) => nudges.push(args);
const { notifyUser } = require('../../../services/notification/notify.service');
const { noticeFor, AUDIENCE, createNotificationBridge } = require('../../../services/judgeSandbox/notifications.service');
(async () => {
  assert.throws(() => createNotificationBridge({ proof: { mode: 'offline_judge_core' }, authorize() {}, domain: { load() {} } }));
  guard.installOfflineSandbox({ database: 'artrelo_judge_notices_test', frontendOrigin: 'http://127.0.0.1:3143' });
  const ordinary = await notifyUser({ userId: 'profile1', type: 'work_order_created', title: 'Request received', message: 'Recorded', email: 'never@example.invalid' });
  assert(ordinary);assert.equal(emails, 0);assert.equal(writes[0].metadata.sandbox, true);assert.equal(writes[0].metadata.simulated, false);
  assert.deepEqual(nudges, [['profile1', 'notifications']], 'normal in-app update remains after committed write');
  await notifyUser({ userId: 'profile1', type: 'judge_run_update', title: 'Report', message: 'No repair verified', metadata: { simulated: true } });
  assert(writes[1].title.includes('Simulated vendor'));assert.equal(emails, 0);
  for (const [action, audiences] of Object.entries(AUDIENCE)) for (const audience of audiences) {
    const notice = noticeFor(action, audience, true);assert(notice?.title);assert(notice.message);
    if (audience === 'tenant') assert(!/\$|\b275\b|\b240\b|ceiling|quota|itemiz|financial|wallet/i.test(notice.message), 'tenant progress must not expose commercial details');
  }
  const schema = Notification.schema;
  assert(schema.path('type').enumValues.includes('intake_details_needed'), 'existing intake notice must not silently drop');
  assert(schema.path('type').enumValues.includes('judge_run_update'));
  assert.equal(noticeFor('unknown', 'tenant', true), null, 'unknown audit events never become messages');
  console.log('PASS sandbox notifications: real guard required, normal bell/SSE preserved, explicit email never invoked, simulation truth and tenant commercial privacy, closed event map.');
})().catch(e => { console.error(e);process.exitCode = 1; });
