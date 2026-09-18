'use strict';

const DEFAULT_PROMPT = '只对这张图片中原本存在的水印、文字标记或半透明 Logo 覆盖区域进行局部修复，并使用紧邻区域的原有纹理自然补全。除水印实际覆盖的局部区域外，其他内容必须保持与输入原图一致：不得改变背景、主体、构图、位置、大小、色彩、光影、清晰度、画幅比例和分辨率；不得扩图、裁切、重新构图、移动或缩放主体，也不得重绘未被水印遮挡的区域。只输出一张处理后的图片，不要添加任何新文字、Logo、边框或说明。';
const MANUAL_EDIT_PROMPT = '这张图上覆盖了用户临时绘制的亮粉色半透明笔刷标记。亮粉色笔刷只是编辑区域指示，不是原图内容。请彻底移除所有亮粉色标记，并且只修复标记覆盖的局部区域，使用其紧邻区域原有的纹理、背景和光影自然补全。标记之外的所有像素内容必须尽可能保持与输入图一致，不得改变主体、构图、位置、大小、色彩、清晰度、画幅比例或分辨率，不得扩图、裁切或重新构图。只输出一张处理后的图片，不要保留粉色笔刷，也不要添加任何文字、Logo、边框或说明。';

// 界面切到英文时使用的默认提示词（与中文版语义一一对应，随语言切换整体替换）
const DEFAULT_PROMPT_EN = 'Repair only the areas of this image that are covered by existing watermarks, text marks, or semi-transparent logos, and fill them in naturally using the original textures of the immediately surrounding areas. Everything outside the watermark-covered regions must stay identical to the input image: do not change the background, subject, composition, position, size, colors, lighting, sharpness, aspect ratio, or resolution; do not outpaint, crop, recompose, move, or rescale the subject, and do not repaint areas that were not covered by watermarks. Output exactly one processed image, with no added text, logos, borders, or explanations.';
const MANUAL_EDIT_PROMPT_EN = 'This image is overlaid with temporary bright-pink semi-transparent brush marks drawn by the user. The pink strokes only indicate the areas to edit and are not part of the original image. Completely remove all bright-pink marks and repair only the local areas they cover, filling them in naturally with the original textures, background, and lighting of the immediately surrounding areas. All pixels outside the marks must stay as close to the input image as possible: do not change the subject, composition, position, size, colors, sharpness, aspect ratio, or resolution; do not outpaint, crop, or recompose. Output exactly one processed image, with no pink strokes left and no added text, logos, borders, or explanations.';
const WATERMARK_AUDIT_PROMPT = '你是图片水印残留检测器。请完整扫描整张图片，不得只看最明显的一处。只识别后期叠加、平台叠加或人为覆盖在画面上的标记，包括任意语言文字、半透明文字、低对比度文字、Logo、品牌标、用户名、账号、署名、签名、角标、印章、图标、二维码、旋转或竖排文字、弧形文字、边缘被裁掉一部分的标记、重复平铺水印以及同一张图中的多处独立水印。不要把场景中真实存在的招牌、包装文字、衣服印花、屏幕内容、路牌、物体标签等自然画面内容误判为水印。只输出一个 JSON 对象，不要解释，不要 Markdown。格式必须为：{"hasResidual":true,"confidence":0.95,"regions":[{"x":0.1,"y":0.2,"w":0.3,"h":0.08,"confidence":0.92,"kind":"text"}]}。坐标均为 0 到 1 的相对坐标，x/y 是左上角，w/h 是宽高；每个区域必须完整包住对应标记，可略微留边；最多返回 48 个区域。如果确认没有任何残留水印，返回：{"hasResidual":false,"confidence":0.95,"regions":[]}。';
const WATERMARK_AUDIT_PROMPT_EN = 'Act as a residual-watermark detector. Scan the entire image, not only the most obvious area. Detect only marks that were overlaid after the scene was captured or generated, including text in any language, translucent or low-contrast text, logos, brand marks, usernames, account IDs, credits, signatures, corner bugs, stamps, icons, QR codes, rotated or vertical text, curved text, partially clipped edge marks, repeated tiled watermarks, and multiple independent watermarks in one image. Do not classify real scene content such as signs, packaging text, clothing prints, screens, road signs, or object labels as watermarks. Output exactly one JSON object with no explanation and no Markdown. Required format: {"hasResidual":true,"confidence":0.95,"regions":[{"x":0.1,"y":0.2,"w":0.3,"h":0.08,"confidence":0.92,"kind":"text"}]}. Coordinates are normalized from 0 to 1; x/y are the top-left corner and w/h are width/height. Each region must fully cover one mark with a small margin. Return at most 48 regions. If no residual watermark is present, return {"hasResidual":false,"confidence":0.95,"regions":[]}.';

function buildPrompt(settings = {}) {
  const base = String(settings.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT;
  return base;
}

function buildManualEditPrompt(settings = {}) {
  const base = String(settings.manualEditPrompt || MANUAL_EDIT_PROMPT).trim() || MANUAL_EDIT_PROMPT;
  return base;
}

function buildWatermarkAuditPrompt(settings = {}) {
  return settings.language === 'en' ? WATERMARK_AUDIT_PROMPT_EN : WATERMARK_AUDIT_PROMPT;
}

module.exports = {
  DEFAULT_PROMPT,
  DEFAULT_PROMPT_EN,
  MANUAL_EDIT_PROMPT,
  MANUAL_EDIT_PROMPT_EN,
  WATERMARK_AUDIT_PROMPT,
  WATERMARK_AUDIT_PROMPT_EN,
  buildManualEditPrompt,
  buildPrompt,
  buildWatermarkAuditPrompt
};
