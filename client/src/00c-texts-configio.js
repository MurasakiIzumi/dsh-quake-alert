// ============================================================================
// dsh-quake-alert · client/src/00c-texts-configio.js
//
// 作用：配置导出 / 导入这一面的文案表（三语言并列）。
// 内容：纯数据对象，不 import 任何模块（依赖方向：面文件 ← 00-i18n.js ← 其它）。
// 依赖：无。
//
// 为什么单独一个面文件、而不并进设置页那一份：它的**错误码 → 文案**映射是一张独立的表
// （导入失败有 5 种可区分的失败），与设置页的控件文案没有共同关注面；分开后 review
// "导入失败会说什么"时不必翻 300 条设置文案。
// ============================================================================

const CONFIG_IO = {
  'zh-CN': {
    'settings.configIo.title': '配置导出与导入',
    'settings.configIo.hint': '备份文件只含设置，不含预警记录。',
    'settings.configIo.exportBtn': '导出配置',
    'settings.configIo.importBtn': '导入配置',
    'settings.configIo.exported': '已导出配置文件。',
    'settings.configIo.exportFallback': '当前环境不能自动下载：请手动复制下面的文本。',
    'settings.configIo.copied': '已复制到剪贴板。',
    'settings.configIo.copyFailed': '复制失败，请手动全选复制。',
    'settings.configIo.imported': '已导入配置。',
    'settings.configIo.undoBtn': '撤销上次导入',
    'settings.configIo.undone': '已恢复导入前的配置。',
    'settings.configIo.noBackup': '没有可撤销的导入记录。',
    'settings.configIo.errJson': '不是有效的 JSON 文件。',
    'settings.configIo.errShape': '文件里没有本插件能读的配置。',
    'settings.configIo.errFormat': '这不是灾害预警插件的配置文件。',
    'settings.configIo.errVersion': '文件缺少格式版本号，或版本号非法。',
    'settings.configIo.errNewer': '文件来自更新版本的插件（格式版本 {v}），当前版本读不了。',
    'settings.configIo.errRead': '读取文件失败。',
    'settings.configIo.errNoFile': '没有选择文件。',
    'settings.configIo.errBackupFailed': '当前环境无法保存备份（浏览器存储可能已满或被禁用）。为避免无法撤销，导入已取消。',
    'settings.configIo.errUnexpected': '导入过程中出错了：{detail}',
  },

  ja: {
    'settings.configIo.title': '設定のエクスポートとインポート',
    'settings.configIo.hint': 'バックアップファイルに含まれるのは設定のみで、警報の履歴は含まれません。',
    'settings.configIo.exportBtn': '設定をエクスポート',
    'settings.configIo.importBtn': '設定をインポート',
    'settings.configIo.exported': '設定ファイルをエクスポートしました。',
    'settings.configIo.exportFallback': 'この環境では自動ダウンロードできません。下のテキストを手動でコピーしてください。',
    'settings.configIo.copied': 'クリップボードにコピーしました。',
    'settings.configIo.copyFailed': 'コピーできませんでした。手動で全選択してコピーしてください。',
    'settings.configIo.imported': '設定をインポートしました。',
    'settings.configIo.undoBtn': '直前のインポートを元に戻す',
    'settings.configIo.undone': 'インポート前の設定に戻しました。',
    'settings.configIo.noBackup': '元に戻せるインポート履歴がありません。',
    'settings.configIo.errJson': '有効な JSON ファイルではありません。',
    'settings.configIo.errShape': 'このファイルには読み込める設定が含まれていません。',
    'settings.configIo.errFormat': '災害警報プラグインの設定ファイルではありません。',
    'settings.configIo.errVersion': '形式バージョンがないか、値が不正です。',
    'settings.configIo.errNewer': 'より新しいバージョンのプラグインが出力したファイルです（形式バージョン {v}）。現在のバージョンでは読み込めません。',
    'settings.configIo.errRead': 'ファイルの読み込みに失敗しました。',
    'settings.configIo.errNoFile': 'ファイルが選択されていません。',
    'settings.configIo.errBackupFailed': 'この環境ではバックアップを保存できません（ブラウザの保存領域が満杯か、無効になっています）。元に戻せなくなるため、インポートを中止しました。',
    'settings.configIo.errUnexpected': 'インポート中にエラーが発生しました：{detail}',
  },

  en: {
    'settings.configIo.title': 'Export and import settings',
    'settings.configIo.hint': 'The backup file contains settings only, not alert history.',
    'settings.configIo.exportBtn': 'Export settings',
    'settings.configIo.importBtn': 'Import settings',
    'settings.configIo.exported': 'Settings file exported.',
    'settings.configIo.exportFallback': 'Automatic download is unavailable here. Copy the text below manually.',
    'settings.configIo.copied': 'Copied to clipboard.',
    'settings.configIo.copyFailed': 'Copy failed. Select all and copy manually.',
    'settings.configIo.imported': 'Settings imported.',
    'settings.configIo.undoBtn': 'Undo last import',
    'settings.configIo.undone': 'Restored the settings from before the import.',
    'settings.configIo.noBackup': 'There is no import to undo.',
    'settings.configIo.errJson': 'Not a valid JSON file.',
    'settings.configIo.errShape': 'This file contains no settings this plugin can read.',
    'settings.configIo.errFormat': 'This is not a disaster alert plugin settings file.',
    'settings.configIo.errVersion': 'The format version is missing or invalid.',
    'settings.configIo.errNewer': 'This file comes from a newer plugin version (format version {v}); this version cannot read it.',
    'settings.configIo.errRead': 'Could not read the file.',
    'settings.configIo.errNoFile': 'No file selected.',
    'settings.configIo.errBackupFailed': 'Could not save a backup (browser storage may be full or disabled). The import was cancelled so it always stays undoable.',
    'settings.configIo.errUnexpected': 'Something went wrong during the import: {detail}',
  },
}

export { CONFIG_IO }
