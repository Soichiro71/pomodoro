/**
 * ポモドーロ → Notion の中継ぎ（Google Apps Script）
 * タイマーから {field, minutes, how, id} を受け取り、Notionの「🍅 ポモドーロ記録」に1行足す。
 * Notionの連携キーは、このコードには書かない。
 *   「プロジェクトの設定」→「スクリプト プロパティ」に NOTION_TOKEN という名前で入れる。
 */
var DB_ID = 'dbbcfbe7cc464448ab2054b663024b79';   // 🍅 ポモドーロ記録
var FIELDS = ['就活', '簿記', '雑学ショート', '大学', 'その他'];

function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);
    if (FIELDS.indexOf(p.field) < 0) return out_('分野が違います');
    var m = Math.round(Number(p.minutes));
    if (!(m >= 1 && m <= 180)) return out_('分数が範囲外です');
    var cache = CacheService.getScriptCache();
    if (p.id && cache.get(p.id)) return out_('送信済み');   // 同じ記録を二重に入れない
    var res = addRow_(p.field, m, p.how);
    if (p.id && res === 200) cache.put(p.id, '1', 21600);
    return out_(res);
  } catch (err) {
    return out_('エラー: ' + err);
  }
}

function doGet() { return out_('ok'); }

function addRow_(field, minutes, how) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('NOTION_TOKEN が未設定です');
  var label = field + ' ' + minutes + '分' + (how === '25分' ? '（🍅）' : (how ? '（' + how + '）' : ''));
  var body = {
    parent: { database_id: DB_ID },
    properties: {
      '内容': { title: [{ text: { content: label } }] },
      '分野': { select: { name: field } },
      '分': { number: minutes }
    }
  };
  var res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) Logger.log(res.getContentText());
  return res.getResponseCode();
}

/** 最初に1回だけ、エディタで「実行」して許可を出す（Notionに「その他 1分（テスト）」が1行入る） */
function test() {
  Logger.log(addRow_('その他', 1, 'テスト'));
}

function out_(s) { return ContentService.createTextOutput(String(s)); }

/* ============================================================
 * Notion「全タスク」→ Googleカレンダー の自動同期（11/11〜）
 * 15分ごとに動き、Googleカレンダーの2つの専用カレンダーに書き写す。
 *   「Notion 締切」…期日（締切）がある行。時刻つきは締切の30分前〜締切
 *   「Notion やる日」…期日がなく、やる日だけある行（1日分の行など）。終日
 * Done・Complete・Project・Inbox・WishList の行は出さない（消える）。
 * 範囲は3日前〜60日後。Notion側で直すと、次の同期でGoogle側も直る。
 * 最初に1回だけ setupCalendarSync を実行する（許可が出る）。
 * ============================================================ */
var TASK_DB_ID = '1c64ce8a982a40cb8f94d5106fcdfd82';   // 全タスク
var CAL_DUE = 'Notion 締切';
var CAL_DO = 'Notion やる日';
var TZ = 'Asia/Tokyo';
var SKIP_STATES = ['Complete', 'Project', 'Inbox', 'WishList'];

function setupCalendarSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCalendar') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncCalendar').timeBased().everyMinutes(15).create();
  syncCalendar();
}

function syncCalendar() {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  var now = new Date();
  var from = new Date(now.getTime() - 3 * 864e5);
  var to = new Date(now.getTime() + 60 * 864e5);
  var fromStr = Utilities.formatDate(from, TZ, 'yyyy-MM-dd');

  // 1) Notionから未完了の行を読む
  var rows = [], cursor = null;
  do {
    var body = {
      page_size: 100,
      filter: { and: [
        { property: 'Done', checkbox: { equals: false } },
        { or: [
          { property: '期日', date: { on_or_after: fromStr } },
          { property: 'やる日', date: { on_or_after: fromStr } }
        ] }
      ] }
    };
    if (cursor) body.start_cursor = cursor;
    var res = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + TASK_DB_ID + '/query', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28' },
      payload: JSON.stringify(body)
    });
    if (res.getResponseCode() !== 200) throw new Error('Notion ' + res.getResponseCode() + ': ' + res.getContentText());
    var j = JSON.parse(res.getContentText());
    rows = rows.concat(j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);

  // 2) カレンダーにある、この同期が作った予定を集める
  var cals = { due: getCal_(CAL_DUE, CalendarApp.Color.RED), doDay: getCal_(CAL_DO, CalendarApp.Color.GRAY) };
  var existing = {};
  [cals.due, cals.doDay].forEach(function (cal) {
    cal.getEvents(new Date(now.getTime() - 30 * 864e5), new Date(now.getTime() + 400 * 864e5)).forEach(function (ev) {
      var id = ev.getTag('notionId');
      if (!id) return;
      if (existing[id]) { ev.deleteEvent(); return; }   // 重複は消す
      existing[id] = ev;
    });
  });

  // 3) 作る・直す
  var seen = {};
  rows.forEach(function (r) {
    var p = r.properties;
    var st = p['状態'] && p['状態'].status ? p['状態'].status.name : '';
    if (SKIP_STATES.indexOf(st) >= 0) return;
    var title = (p['タスク'] && p['タスク'].title || []).map(function (t) { return t.plain_text; }).join('');
    var due = p['期日'] && p['期日'].date;
    var doDay = p['やる日'] && p['やる日'].date;
    var d = due || doDay;
    if (!d || !d.start) return;
    var start = d.start;
    var startDate = start.length > 10 ? new Date(start) : Utilities.parseDate(start, TZ, 'yyyy-MM-dd');
    if (startDate > to) return;
    var isDue = !!due;
    var name = (isDue ? '〆 ' : '') + title;
    var sig = (isDue ? 'D' : 'W') + '|' + name + '|' + start;
    var ev = existing[r.id];
    seen[r.id] = true;
    if (ev && ev.getTag('sig') === sig) return;          // 変わっていない
    if (ev) ev.deleteEvent();
    var cal = isDue ? cals.due : cals.doDay;
    var opt = { description: r.url };
    var nev;
    if (start.length > 10) {
      nev = cal.createEvent(name, new Date(startDate.getTime() - 30 * 60000), startDate, opt);
    } else {
      nev = cal.createAllDayEvent(name, startDate, opt);
    }
    nev.setTag('notionId', r.id);
    nev.setTag('sig', sig);
  });

  // 4) Notionで終わった・消えた行の予定を消す（過去の分は残す）
  Object.keys(existing).forEach(function (id) {
    if (seen[id]) return;
    var ev = existing[id];
    if (ev.getEndTime() >= from) ev.deleteEvent();
  });
}

function getCal_(name, color) {
  var cs = CalendarApp.getCalendarsByName(name);
  if (cs.length) return cs[0];
  var c = CalendarApp.createCalendar(name, { timeZone: TZ });
  try { c.setColor(color); } catch (e) {}
  return c;
}
