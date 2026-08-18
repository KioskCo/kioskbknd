const postgres = require('postgres');

(async () => {
  const sql = postgres(
    'postgresql://postgres.ykffijvdqjyguwfwysho:%40Kiosk.co22@aws-1-eu-central-1.pooler.supabase.com:5432/postgres',
    { ssl: 'require', max: 2 },
  );
  try {
    const rows = await sql`
      select u.username, u.business_name, t.id as tpl_id, t.name, t.launched, t.launch_url,
             t.store_paused,
             (t.settings->>'templateJson') is not null as has_json,
             length(coalesce(t.settings->>'templateJson','')) as tpl_len,
             t.updated_at
      from users u
      left join templates t on t.user_id = u.id
      order by u.created_at desc
    `;
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await sql.end();
  }
})().catch((e) => console.error('ERR', e.message));