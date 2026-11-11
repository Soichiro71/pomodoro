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
