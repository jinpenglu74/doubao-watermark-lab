'use strict';

// 界面中英文词典：以中文原文为 key，默认语言（zh）直接原样返回，避免全量改造调用点。
// - EXACT：静态文案与带 {占位符} 的模板
// - PATTERNS：主进程/自动化层发来的动态消息（带数字、文件名等），按正则匹配翻译
// 同一份文件同时供浏览器窗口（window.wlI18n）与 Node 测试（module.exports）使用
(function (globalScope) {
  const EXACT = {
    // ---- 品牌与主窗口 ----
    '水印清理工作台': 'Watermark Lab',
    '正在检查豆包状态': 'Checking Doubao status',
    '豆包已登录 · 状态已保存': 'Doubao signed in · session saved',
    '豆包未登录': 'Doubao not signed in',
    '登录豆包': 'Sign in to Doubao',
    '打开豆包': 'Open Doubao',
    '退出登录': 'Sign out',
    '处理队列': 'Processing queue',
    '逐张上传，串行处理，避免对话结果错位': 'Uploads one by one so results never get mixed up',
    '{n} 张': '{n} image(s)',
    '拖入图片或文件夹，或点击选择': 'Drop images or folders here, or click to browse',
    '支持 JPG、PNG、WEBP、HEIC 等格式 · 文件夹自动全部加入 · 截图可直接 Cmd/Ctrl+V 粘贴': 'Supports JPG, PNG, WEBP, HEIC and more · Folders are added recursively · Paste screenshots with Cmd/Ctrl+V',
    '选择图片': 'Browse',
    '等待添加原图': 'Add images to get started',
    '处理进度与导出方式会显示在这里': 'Progress and export options will show up here',
    '全选 / 取消全选': 'Select all / deselect all',
    '全选': 'Select all',
    '清空': 'Clear',
    '任务间隔': 'Interval',
    '每张图片处理完成后等待的秒数；多线程模式下不生效（任务全部同时进行）': 'Seconds to wait after each image; ignored in multi-thread mode (all tasks start together)',
    '秒': 's',
    '无图等待': 'Image wait',
    '豆包回复结束后，继续等待图片出现的秒数；超过后判定为未生成。图片出得慢、被误判“没有生成图片”时可调大': 'Seconds to keep waiting for the image after Doubao\'s reply ends. Increase it if slow generations get misjudged as "no image"',
    '多线程': 'Multi-thread',
    '开启后同时处理多张图片（并行数量见右侧「同时处理」）；若频繁触发安全验证请关闭或调低数量': 'Process multiple images at once (count set in "Concurrency"); turn it off or lower the count if security checks trigger often',
    '同时处理': 'Concurrency',
    '最多同时处理的任务数（1-8）；数量越大内存占用越高，也越容易触发安全验证': 'Max simultaneous tasks (1-8); higher values use more memory and trigger security checks more easily',
    '个': '',
    '处理设置': 'Processing settings',
    '使用已验证的稳定处理方案': 'Uses the proven stable pipeline',
    '自动保持原图比例': 'Keeps the original aspect ratio',
    '{edge}添加 {p} 临时隔离带，白边补偿 {q}。': 'Adds a {p} temporary buffer at the {edge}, edge trim {q}.',
    '顶部': 'top',
    '底部': 'bottom',
    '高级设置': 'Advanced settings',
    '打开高级设置': 'Open advanced settings',
    '覆盖原图': 'Overwrite originals',
    '通过最终复检和质检后安全替换原文件；异常结果不会覆盖': 'Safely replaces the original only after final audit and QC; abnormal results are never overwritten',
    '开启“覆盖原图”后，只有通过最终残留复检和像素质检的处理结果才会替换原文件；处理失败、存在疑似残留或质检异常时不会覆盖。是否继续？': 'When "Overwrite originals" is enabled, only results that pass the final residual-watermark audit and pixel QC will replace the original file. Failed, uncertain, or abnormal results will never overwrite it. Continue?',
    '通过最终复检和质检的图片会安全覆盖原文件；未通过的结果仍保存在输出目录': 'Images that pass the final audit and QC safely replace the original; other results stay in the output folder',
    '显示豆包处理窗口': 'Show Doubao window',
    '关闭后在后台处理；安全验证时仍会临时显示': 'Runs in the background when off; still pops up for security verification',
    '界面外观': 'Appearance',
    '选择深浅模式与玻璃色调': 'Pick light/dark mode and accent color',
    '展开颜色设置': 'Show color options',
    '收起颜色设置': 'Hide color options',
    '颜色设置': 'Color options',
    '界面调色盘': 'Color palette',
    '森屿绿': 'Forest green',
    '湖海蓝': 'Ocean blue',
    '暮光紫': 'Twilight violet',
    '落日橙': 'Sunset orange',
    '石墨灰': 'Graphite gray',
    '自定义主题色': 'Custom accent color',
    '选择任意颜色': 'Pick any color',
    '选择自定义主题色': 'Pick a custom accent color',
    '界面明暗模式': 'Light/dark mode',
    '语言': 'Language',
    '自动': 'Auto',
    '浅色': 'Light',
    '深色': 'Dark',
    '输出目录': 'Output folder',
    '请选择文件夹': 'Choose a folder',
    '更改': 'Change',
    '处理完成的图片会自动保存到这里': 'Processed images are saved here automatically',
    '打开输出目录': 'Open output folder',
    '批量导出': 'Export ZIP',
    '把勾选的已完成图片打包导出为 ZIP': 'Export the checked completed images as a ZIP',
    '停止任务': 'Stop',
    '正在停止…': 'Stopping…',
    '批量处理': 'Start batch',
    '原图放大预览': 'Source zoom preview',

    // ---- 队列条目 ----
    '勾选后参与本次批处理': 'Include in this batch',
    '选择 {name}': 'Select {name}',
    '直取原图': 'Original via API',
    '降级裁切': 'Fallback crop',
    '页面采集': 'Page capture',
    '已从豆包接口直取无水印原图：未加隔离带、未裁切': 'Watermark-free original captured straight from the Doubao API: no buffer, no cropping',
    '接口未拦截到无水印原图，已自动加隔离带重发并完成裁切': 'API capture missed; automatically resent with a buffer strip and cropped',
    '接口未拦截到无水印原图，已使用页面生成结果（未加隔离带）': 'API capture missed; used the in-page result (no buffer strip)',
    '质检：疑似未处理': 'QC: likely unprocessed',
    '质检：差异过大': 'QC: excessive difference',
    '已覆盖原图': 'Original overwritten',
    '最终复检和像素质检均通过，已安全替换原文件': 'Final residual audit and pixel QC both passed; the original file was safely replaced',
    '未覆盖：手动重绘': 'Not overwritten: manual retouch',
    '手动涂抹重绘不会自动覆盖原图，结果保留在输出目录': 'Manual brush retouch does not automatically overwrite the original; the result stays in the output folder',
    '未覆盖：复检未通过': 'Not overwritten: audit failed',
    '残留水印最终复检未通过，为保护原文件没有覆盖': 'The final residual-watermark audit did not pass, so the original file was protected',
    '未覆盖：质检未通过': 'Not overwritten: QC failed',
    '最终像素质检未通过，为保护原文件没有覆盖': 'Final pixel QC did not pass, so the original file was protected',
    '未覆盖：格式限制': 'Not overwritten: format limitation',
    '当前原图格式无法安全保持原格式覆盖，结果保留在输出目录': 'This source format cannot be safely overwritten while preserving its format; the result stays in the output folder',
    '未覆盖：替换失败': 'Not overwritten: replacement failed',
    '安全替换原文件失败，原图保持不变，结果保留在输出目录': 'Safe replacement failed; the original is unchanged and the result stays in the output folder',
    '未覆盖原图': 'Original not overwritten',
    '原图保持不变': 'The original file is unchanged',
    '复检：仍有疑似残留': 'Audit: possible residue remains',
    '复检：需人工确认': 'Audit: review needed',
    '复检：未完成': 'Audit: incomplete',
    '补修：未完成': 'Repair: incomplete',
    '自动定点补修已达到上限，仍检测到疑似残留；建议点击预览确认': 'Automatic targeted repair reached its limit and possible residue still remains; preview the result to confirm',
    '检测到低置信度疑似标记，为避免误删真实场景文字，未自动处理': 'A low-confidence possible mark was detected; it was not auto-removed to avoid deleting real scene text',
    '残留水印自动复检未完成，当前结果已保留': 'Residual-watermark audit did not finish; the current result was kept',
    '自动定点补修未完成，已保留上一版有效结果': 'Automatic targeted repair did not finish; the previous valid result was kept',
    '与原图相比变化像素仅 {p}%，疑似没有实际处理；点击"预览"查看差异热力图': 'Only {p}% of pixels differ from the source — it may not have been processed. Click "Preview" to see the diff heatmap',
    '与原图相比变化像素达 {p}%，差异异常大；点击"预览"查看差异热力图': '{p}% of pixels differ from the source — unusually large. Click "Preview" to see the diff heatmap',
    '本次跳过': 'Skipped this run',
    '等待处理': 'Waiting',
    '可以重新开始任务重试': 'Restart the task to retry',
    '队列 #{index}': 'Queue #{index}',
    '原图已移动或删除，无法重新生成': 'Source image moved or deleted; cannot regenerate',
    '正在发起重新生成…': 'Requesting regeneration…',
    '重新生成（接回该图片的历史对话）': 'Regenerate (reuses this image\'s conversation)',
    '重新生成': 'Regenerate',
    '预览': 'Preview',
    '涂抹重绘': 'Brush retouch',
    '原图已移动或删除，无法手动涂抹': 'Source image moved or deleted; cannot retouch',
    '在原图上涂抹后重新发送': 'Paint over the source image and resend',
    '移除': 'Remove',

    // ---- 主窗口动态提示 ----
    '最多同时处理 {n} 张图片，请等待其中一张完成': 'Up to {n} images at once — wait for one to finish',
    '正在生成涂抹标记': 'Creating brush marks',
    '多线程模式已开启：{n} 张图片同时处理': 'Multi-thread mode on: processing {n} images at once',
    '准备局部重绘': 'Preparing local retouch',
    '准备处理': 'Preparing',
    '豆包触发了安全验证，已暂停任务并显示验证窗口，请手动完成': 'Doubao asked for security verification. Tasks are paused — complete it in the popup window',
    '安全验证已完成，正在重新开始被中断的任务': 'Verification complete; restarting interrupted tasks',
    '{name}：质检提示结果与原图几乎无差异，建议预览确认或重新生成': '{name}: QC found almost no difference from the source — preview it or regenerate',
    '{name}：质检提示结果与原图差异过大，请预览确认': '{name}: QC found an unusually large difference — please preview',
    '局部重绘已停止': 'Local retouch stopped',
    '批处理已停止': 'Batch stopped',
    '局部重绘失败，请调整涂抹区域后重试': 'Local retouch failed — adjust the marks and retry',
    '处理结束：成功 {a} 张，失败 {b} 张': 'Finished: {a} succeeded, {b} failed',
    '局部重绘完成，点击预览查看结果': 'Local retouch done — click Preview to view',
    '全部完成，共导出 {n} 张图片': 'All done — {n} images exported',
    '{name}：{error}': '{name}: {error}',
    '已打开豆包登录界面，登录状态会自动保存': 'Doubao sign-in opened; your session will be saved automatically',
    '已退出豆包登录，并清除本工具保存的登录状态': 'Signed out of Doubao and cleared the saved session',
    '这些图片已经在队列中': 'These images are already in the queue',
    '拖入的内容里没有可处理的图片': 'No processable images in the dropped items',
    '图片较多，已先添加前 {n} 张': 'Large drop — added the first {n} images',
    '已从剪贴板添加图片': 'Image added from clipboard',
    '剪贴板图片保存失败': 'Failed to save the clipboard image',
    '高级处理设置已保存': 'Advanced settings saved',
    '请先勾选要导出的已完成任务': 'Check the completed tasks you want to export first',
    '已导出 {n} 张图片：{path}': 'Exported {n} images: {path}',
    '没有可导出的图片': 'Nothing to export',
    '发现新版本 {v}，正在后台下载，完成后会提示重启': 'New version {v} found — downloading in the background, you\'ll be asked to restart when ready',
    '正在下载新版本 {v} 安装包，请稍候…': 'Downloading the version {v} installer…',

    // ---- 高级设置窗口 ----
    '高级处理设置': 'Advanced settings',
    '调整后会自动保存，并应用到下一次任务': 'Saved automatically and applied to the next task',
    '豆包提示词': 'Doubao prompt',
    '涂抹重绘提示词': 'Brush retouch prompt',
    '手动涂抹后发送给豆包的局部修复指令；留空则恢复默认': 'Instruction sent to Doubao after manual brushing; leave empty to restore the default',
    '默认直取无水印原图，不加隔离带、不裁切；以下设置仅在拦截失败自动降级重发时生效': 'By default the watermark-free original is captured directly (no buffer, no crop); the settings below only apply when capture fails and the task falls back to resending',
    '隔离带与裁切位置': 'Buffer & crop position',
    '隔离带与基础裁切比例': 'Buffer & base crop ratio',
    '比例越大，越容易完整容纳 AI 标识': 'A larger ratio fits the AI badge more reliably',
    '白边补偿裁切': 'Edge-trim compensation',
    '恢复原图比例后再向内裁少量边缘；建议保持 0.5%': 'Trims a sliver inward after restoring the aspect ratio; 0.5% recommended',
    '取消': 'Cancel',
    '保存设置': 'Save settings',

    // ---- 涂抹窗口 ----
    '手动涂抹': 'Brush retouch',
    '手动涂抹局部重绘区域': 'Paint the areas to retouch',
    '手动涂抹 · {name}': 'Brush retouch · {name}',
    '正在载入原图…': 'Loading source image…',
    '原图涂抹画布': 'Source painting canvas',
    '亮粉色画笔覆盖重绘区域 · ⌘/Ctrl+滚轮缩放 · 空格+拖拽平移': 'Paint retouch areas in pink · ⌘/Ctrl+scroll to zoom · Space+drag to pan',
    '画笔大小': 'Brush size',
    '只会将涂抹区域作为局部修复指示发送给豆包': 'Only the painted areas are sent to Doubao as retouch hints',
    '撤销': 'Undo',
    '发送局部重绘': 'Send retouch',
    '正在发送…': 'Sending…',
    '请在原图上覆盖需要豆包重新处理的位置': 'Paint over the spots you want Doubao to redo',
    '原图 {w} × {h} · 涂抹轨迹会按原始分辨率发送': 'Source {w} × {h} · strokes are sent at native resolution',
    '原图载入失败，请关闭窗口重试': 'Failed to load the source image — close this window and retry',

    // ---- 预览窗口 ----
    '处理结果预览': 'Result preview',
    '预览 · {name}': 'Preview · {name}',
    '正在载入…': 'Loading…',
    '正在载入预览…': 'Loading preview…',
    '查看质检差异热力图：红色区域为与原图的差异处': 'Show the QC diff heatmap: red marks differences from the source',
    '差异热力': 'Diff heatmap',
    '与原图对比': 'Compare with the source image',
    '对比原图': 'Compare',
    '预览缩放': 'Preview zoom',
    '缩小（⌘-）': 'Zoom out (⌘-)',
    '缩小': 'Zoom out',
    '适合窗口（⌘0）': 'Fit to window (⌘0)',
    '适合': 'Fit',
    '放大（⌘+）': 'Zoom in (⌘+)',
    '放大': 'Zoom in',
    '原图': 'Source',
    '结果': 'Result',
    '拖动分割线对比': 'Drag the divider to compare',
    '⌘ + / − 缩放 · ⌘ 0 还原 · 放大后拖拽查看': '⌘ +/− to zoom · ⌘0 to reset · drag to pan when zoomed',
    '原图 · {w} × {h}': 'Source · {w} × {h}',
    ' · 变化像素 {p}%': ' · changed pixels {p}%',

    // ---- 后端进度消息（自动化层 onProgress，原样字符串） ----
    '正在创建新对话': 'Opening a new conversation',
    '正在打开该任务的历史对话': 'Reopening this task\'s conversation',
    '正在上传原图': 'Uploading the source image',
    '已拦截到豆包返回的无水印原图': 'Captured the watermark-free original from Doubao',
    '正在填写处理指令': 'Entering the instruction',
    '正在全图复检残留水印': 'Scanning the whole image for residual watermarks',
    '残留水印复检返回格式异常，未能解析检测结果': 'Residual-watermark audit returned an invalid format',
    '残留水印复检超时': 'Residual-watermark audit timed out',
    '豆包正在重绘图片': 'Doubao is redrawing the image',
    '正在通过豆包原生保存导出生成图': 'Exporting via Doubao\'s native save',
    '最终复检和质检均通过，正在安全覆盖原图': 'Final audit and QC passed; safely replacing the original file',
    '已安全覆盖原图': 'Original file safely replaced',
    '手动涂抹重绘不会自动覆盖原图，结果已保留在输出目录': 'Manual brush retouch does not automatically overwrite the original; the result was kept in the output folder',
    '残留水印最终复检未通过，不覆盖原图': 'Final residual-watermark audit did not pass; the original will not be overwritten',
    '最终像素质检未通过，不覆盖原图': 'Final pixel QC did not pass; the original will not be overwritten',
    '原图格式暂不支持安全覆盖；结果已保留在输出目录': 'The source format is not currently supported for safe overwrite; the result was kept in the output folder',
    '处理结果无法保持原图格式，未覆盖原图；结果已保留在输出目录': 'The result could not preserve the source format, so the original was not overwritten; the result was kept in the output folder',
    '处理结果无法读取，未覆盖原图': 'The result could not be read, so the original was not overwritten',
    '无法按原图格式重新编码，未覆盖原图': 'The result could not be re-encoded in the source format, so the original was not overwritten',
    '原图不存在，无法覆盖': 'The original file no longer exists and cannot be overwritten',
    '覆盖前校验失败：处理结果无法正常读取': 'Pre-overwrite validation failed: the processed result could not be read',
    '覆盖后校验失败：原图位置的新文件无法读取': 'Post-overwrite validation failed: the replacement file could not be read',
    '链接不可用，正在从豆包高清预览导出': 'Link unavailable — exporting from the HD preview',
    '检测到豆包安全验证：任务已暂停，请在豆包窗口手动完成': 'Doubao security verification detected: task paused — complete it in the Doubao window',
    '检测到安全验证：另一个窗口正在验证，完成一次即可，本任务已暂停等待自动重跑': 'Security verification detected: another window is verifying (once is enough) — this task is paused and will rerun automatically',
    '安全验证已完成，正在重新开始任务': 'Verification complete — restarting the task',
    '登录状态异常，正在自动恢复…': 'Login state looks abnormal — recovering automatically…',
    '另一个任务正在恢复豆包登录，本任务已暂停等待': 'Another task is restoring the Doubao session; this task is waiting',
    '豆包登录状态正常，正在重新开始任务': 'Doubao login is healthy — restarting the task',
    '正在刷新豆包会话…': 'Refreshing the Doubao session…',
    '豆包会话已自动恢复，正在重新开始任务': 'Doubao session recovered automatically — restarting the task',
    '正在重置豆包工作窗口…': 'Resetting the Doubao worker window…',
    '豆包工作窗口已恢复，正在重新开始任务': 'Doubao worker window recovered — restarting the task',
    '豆包需要重新登录，任务已暂停；登录成功后会自动继续': 'Doubao requires sign-in again. The task is paused and will continue automatically after sign-in',
    '登录会话已恢复，正在重新开始任务': 'Login session restored — restarting the task',

    // ---- 后端错误消息（原样字符串） ----
    '批处理已取消': 'Batch cancelled',
    '安全验证已中断本次任务': 'Security verification interrupted this task',
    '豆包登录状态需要恢复': 'Doubao login state needs recovery',
    '豆包登录会话已恢复，需要重新开始本次任务': 'Doubao login session was restored; this task needs to restart',
    '豆包工作窗口已关闭，无法自动恢复登录': 'The Doubao worker window was closed, so login cannot be recovered automatically',
    '豆包会话恢复加载超时': 'Doubao session recovery timed out while loading',
    '等待豆包重新登录超时；当前任务未丢失，可完成登录后重新开始': 'Timed out waiting for Doubao sign-in; the task was not lost and can be restarted after signing in',
    '豆包登录会话多次恢复后仍异常，请稍后重新开始该任务': 'The Doubao login session remained abnormal after multiple recovery attempts; restart this task later',
    '豆包页面响应超时，请刷新页面后重试': 'Doubao page timed out — refresh and retry',
    '等待手动完成豆包安全验证超时；请完成验证后重新开始任务': 'Timed out waiting for manual verification; complete it and restart the task',
    '豆包登录页面加载超时': 'Doubao sign-in page timed out',
    '没有找到豆包登录按钮，请稍后重试': 'Doubao sign-in button not found — try again later',
    '豆包页面加载超时': 'Doubao page timed out',
    '没有找到豆包的图片上传控件；请确认当前是普通对话页面并刷新重试': 'Doubao\'s image upload control not found; make sure it\'s a normal chat page and refresh',
    '图片已选择，但豆包没有显示上传预览': 'Image selected, but Doubao never showed the upload preview',
    '没有找到豆包的消息输入框': 'Doubao\'s message box not found',
    '无法把提示词写入豆包输入框': 'Could not type the prompt into Doubao\'s message box',
    '豆包返回了文字提示，但没有生成图片；可调整提示词后重试': 'Doubao replied with text but generated no image; adjust the prompt and retry',
    '等待豆包生成图片超时': 'Timed out waiting for Doubao to generate the image',
    '豆包登录状态已失效，请重新登录后继续': 'Doubao session expired — sign in again to continue',
    '等待豆包原生保存超时': 'Timed out waiting for Doubao\'s native save',
    '没有找到豆包生成图的保存按钮': 'Save button for the generated image not found',
    '豆包原生保存返回的图片无法读取': 'The natively saved image could not be read',
    '豆包原生保存返回的图片分辨率过低': 'The natively saved image resolution is too low',
    '豆包高清预览没有加载完成': 'Doubao\'s HD preview never finished loading',
    '无法读取豆包高清画布': 'Could not read Doubao\'s HD canvas',
    '无法截取豆包高清画布': 'Could not capture Doubao\'s HD canvas',
    '豆包画布截图分辨率过低': 'The canvas screenshot resolution is too low',
    '批处理运行期间不能退出登录': 'Cannot sign out while a batch is running',
    '请先选择要处理的图片': 'Select images to process first',
    '请先在豆包窗口完成登录；登录状态会自动保存': 'Sign in to Doubao first; your session will be saved automatically',
    '大图链接不可直接下载，切换到高清画布导出': 'The full-size link is not downloadable — switching to HD canvas export',
    '候选资源与上传图片完全相同，已作废并切换到生成结果画布': 'The captured file is identical to the upload — discarded, switching to the result canvas',
    '安全验证后任务仍被中断，请稍后重新开始该任务': 'The task kept getting interrupted after verification; restart it later',
    '原图不存在或格式不受支持': 'Source image missing or format unsupported',
    '质检图片读取失败': 'Failed to read images for QC',
    '预览路径无效': 'Invalid preview path',
    '该文件格式不支持预览': 'This file format cannot be previewed',
    '预览文件无效或过大': 'Preview file invalid or too large',
    '无法读取处理结果': 'Could not read the processed result',
    '涂抹原图路径无效': 'Invalid source path for brushing',
    '该文件格式不支持涂抹': 'This file format cannot be brushed',
    '没有从豆包页面中发现可下载的图片资源': 'No downloadable image found on the Doubao page',
    '发现了图片链接，但无法下载有效的大图；请在豆包窗口确认图片已经生成完成': 'Found image links but no valid full-size download; confirm the image finished generating in the Doubao window',
    '原图像素格式不受支持，无法生成涂抹标记': 'Source pixel format unsupported; cannot create brush marks',
    '请先在原图上涂抹需要处理的区域': 'Paint the areas to process on the source image first',
    '无法读取原图，不能生成涂抹标记': 'Could not read the source image; cannot create brush marks',
    '涂抹标记图生成失败': 'Failed to create the brush-marked image',
    '无法读取原图，不能添加临时空白带': 'Could not read the source image; cannot add the temporary buffer',
    '原图像素格式不受支持，不能添加临时空白带': 'Source pixel format unsupported; cannot add the temporary buffer',
    '临时空白带图片创建失败': 'Failed to create the buffered image',
    '导出内容总大小超过 ZIP 4GB 上限，请减少勾选数量后分批导出': 'Export exceeds the 4GB ZIP limit — uncheck some images and export in batches'
  };

  // 动态后端消息：按正则提取参数后翻译；m 为 match 数组，内部再递归翻译子串
  const PATTERNS = [
    [/^豆包回复已结束，但没有生成图片，提示词可能不合适，请调整后重试(?:；豆包回复：“([\s\S]*)”)?$/,
      (m) => `Doubao's reply ended without an image — the prompt may not fit; adjust and retry${m[1] ? `. Doubao replied: "${m[1]}"` : ''}`],
    [/^豆包回复已结束，继续等待图片出现（最长 (\d+) 秒）$/,
      (m) => `Doubao's reply ended — still waiting for the image (up to ${m[1]}s)`],
    [/^未能拦截到无水印原图，改用隔离带方案：给原图(顶部|底部)添加 ([\d.]+)% 临时空白带后重发$/,
      (m) => `Original capture missed — falling back to the buffer plan: resending with a ${m[2]}% temporary strip at the ${m[1] === '底部' ? 'bottom' : 'top'}`],
    [/^安全验证已中断任务，正在重新开始（第 (\d+)\/(\d+) 次）$/,
      (m) => `Verification interrupted the task — restarting (attempt ${m[1]}/${m[2]})`],
    [/^登录状态异常，正在自动复查（(\d+)\/(\d+)）$/,
      (m) => `Login state looks abnormal — rechecking automatically (${m[1]}/${m[2]})`],
    [/^登录会话已恢复，正在重新开始当前任务（第 (\d+)\/(\d+) 次）$/,
      (m) => `Login session restored — restarting the current task (attempt ${m[1]}/${m[2]})`],
    [/^正在全图复检残留水印（(\d+)\/(\d+)）$/,
      (m) => `Scanning the whole image for residual watermarks (${m[1]}/${m[2]})`],
    [/^检测到 (\d+) 处疑似残留，正在自动定点补修第 (\d+) 轮$/,
      (m) => `Detected ${m[1]} possible residual region(s); running targeted repair pass ${m[2]}`],
    [/^残留水印自动复检未完成：([\s\S]+)；已保留当前结果$/,
      (m) => `Residual-watermark audit did not finish: ${translate(m[1])}; current result kept`],
    [/^自动定点补修失败：([\s\S]+)；已保留上一版有效结果$/,
      (m) => `Automatic targeted repair failed: ${translate(m[1])}; previous valid result kept`],
    [/^最终质检未完成：([\s\S]+)；不会覆盖原图$/,
      (m) => `Final QC did not finish: ${translate(m[1])}; the original will not be overwritten`],
    [/^([\s\S]+)；原图保持不变$/,
      (m) => `${translate(m[1])}; the original file is unchanged`],
    [/^自动补修已达到 2 轮，仍检测到疑似残留，已保留当前最佳结果$/,
      () => 'Automatic repair reached 2 passes; possible residue remains, so the best current result was kept'],

    [/^豆包页面加载失败（(.+)），请检查网络后重试$/,
      (m) => `Doubao page failed to load (${m[1]}) — check your network and retry`],
    [/^豆包原生保存未完成（(.+)）$/,
      (m) => `Doubao's native save did not finish (${m[1]})`],
    [/^没有找到可打开的豆包生成结果（候选链接 (\d+) 个）$/,
      (m) => `No openable generated result found (${m[1]} candidate links)`],
    [/^豆包原生保存不可用，改用高清画布导出：([\s\S]+)$/,
      (m) => `Native save unavailable — switching to HD canvas export: ${translate(m[1])}`],
    [/^([\s\S]+)；高清画布兜底也失败：([\s\S]+)$/,
      (m) => `${translate(m[1])}; the HD canvas fallback also failed: ${translate(m[2])}`],
    [/^豆包返回了上传原图而不是生成结果；生成结果画布导出也失败：([\s\S]+)$/,
      (m) => `Doubao returned the uploaded source instead of a result; canvas export also failed: ${translate(m[1])}`],
    [/^最多同时处理 (\d+) 张图片，请等待其中一张完成$/,
      (m) => `Up to ${m[1]} images at once — wait for one to finish`],
    [/^下载失败 HTTP (\d+)$/, (m) => `Download failed with HTTP ${m[1]}`]
  ];

  let language = 'zh';

  function translate(text) {
    const trimmed = String(text).trim();
    if (!trimmed) return text;
    const exact = EXACT[trimmed];
    if (exact !== undefined) return exact;
    for (const [pattern, replacer] of PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) return replacer(match);
    }
    return text;
  }

  function substitute(template, params) {
    if (!params) return template;
    let output = template;
    for (const [key, value] of Object.entries(params)) {
      output = output.replaceAll(`{${key}}`, String(value));
    }
    return output;
  }

  function t(key, params) {
    let text = String(key ?? '');
    if (language === 'en') {
      // invoke 失败时 Electron 会把主进程错误包一层前缀，剥掉后翻译内部消息
      const wrapped = text.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/);
      if (wrapped) text = wrapped[1];
      text = translate(text);
    }
    return substitute(text, params);
  }

  function applyDom() {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    if (language !== 'en') return;
    document.title = t(document.title);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const trimmed = node.nodeValue.trim();
      if (!trimmed) continue;
      const translated = t(trimmed);
      if (translated !== trimmed) node.nodeValue = node.nodeValue.replace(trimmed, translated);
    }
    for (const element of document.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) {
      for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        const translated = t(value.trim());
        if (translated !== value.trim()) element.setAttribute(attribute, translated);
      }
    }
  }

  const api = {
    init(value) { language = value === 'en' ? 'en' : 'zh'; },
    get language() { return language; },
    t,
    applyDom
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.wlI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
