// P6：图集只读解析与 skeleton ↔ atlas ↔ 图片资源审计。不调用 CLI、不写任何文件。
import fs from 'node:fs';
import path from 'node:path';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const parsePair = (value) => value.split(',').map((item) => Number(item.trim()));

function parseAtlasText(text, source = '(text)') {
  const pages = [];
  let page = null;
  let region = null;
  const malformed = [];

  const finishPage = () => {
    if (page) pages.push(page);
    page = null;
    region = null;
  };

  for (const [lineNumber, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s+/.test(rawLine);
    if (!indented) {
      const [key, value] = line.split(':', 2);
      if (value === undefined) {
        // 无冒号的顶格行：新图集页（第一行）或新 region。
        if (!page) {
          finishPage();
          page = { image: line, headers: {}, regions: [] };
          region = null;
        } else {
          region = { name: line, props: {} };
          page.regions.push(region);
        }
      } else if (page && !region) {
        page.headers[key.trim()] = value.trim();
      } else if (region) {
        region.props[key.trim()] = value.trim();
      } else {
        malformed.push({ line: lineNumber + 1, reason: `页面属性出现在 region 之前: ${line}` });
      }
    } else if (region) {
      const [key, value] = line.trim().split(':', 2);
      if (value === undefined) {
        malformed.push({ line: lineNumber + 1, reason: `region 属性缺少冒号: ${line}` });
      } else {
        region.props[key.trim()] = value.trim();
      }
    } else {
      malformed.push({ line: lineNumber + 1, reason: `缩进行没有所属 region: ${line}` });
    }
  }
  finishPage();
  if (pages.length === 0) malformed.push({ line: 1, reason: '未解析到任何图集页' });
  return { pages, malformed, source };
}

function regionDetails(region) {
  const props = region.props;
  const rotate = props.rotate === 'true';
  const size = parsePair(props.size ?? '0,0');
  const xy = parsePair(props.xy ?? '0,0');
  const orig = parsePair(props.orig ?? props.size ?? '0,0');
  const offset = parsePair(props.offset ?? '0,0');
  return {
    name: region.name,
    index: Number(props.index ?? -1),
    rotate,
    x: xy[0], y: xy[1],
    width: size[0], height: size[1],
    // rotate:true 时图集页上实际占位是宽高互换的，几何校验必须用这两个值。
    pageWidth: rotate ? size[1] : size[0],
    pageHeight: rotate ? size[0] : size[1],
    originalWidth: orig[0], originalHeight: orig[1],
    offsetX: offset[0], offsetY: offset[1],
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.pageWidth && b.x < a.x + a.pageWidth
    && a.y < b.y + b.pageHeight && b.y < a.y + a.pageHeight;
}

export function inspectAtlas(atlasText, { source = '(text)', imageDir = null } = {}) {
  const parsed = parseAtlasText(atlasText, source);
  const issues = [...parsed.malformed];
  const pages = [];
  const names = [];

  for (const page of parsed.pages) {
    const pageSize = parsePair(page.headers.size ?? '0,0');
    const details = page.regions.map(regionDetails);
    for (const detail of details) {
      names.push({ name: detail.name, index: detail.index, page: page.image });
      if (detail.width <= 0 || detail.height <= 0) {
        issues.push({ page: page.image, region: detail.name, reason: 'size 无效' });
      }
      if (detail.x < 0 || detail.y < 0 || detail.x + detail.pageWidth > pageSize[0] || detail.y + detail.pageHeight > pageSize[1]) {
        issues.push({ page: page.image, region: detail.name, reason: `region 矩形超出页面 ${pageSize[0]}x${pageSize[1]}` });
      }
    }
    for (let i = 0; i < details.length; i += 1) {
      for (let j = i + 1; j < details.length; j += 1) {
        if (rectsOverlap(details[i], details[j])) {
          issues.push({ page: page.image, reason: `region 重叠: ${details[i].name} 与 ${details[j].name}` });
        }
      }
    }
    const image = { page: page.image, size: { width: pageSize[0], height: pageSize[1] }, format: page.headers.format ?? null, filter: page.headers.filter ?? null, repeat: page.headers.repeat ?? null, regionCount: details.length, regions: details };
    if (imageDir) {
      const imagePath = path.join(imageDir, page.image);
      let exists = false;
      let stat = null;
      try {
        stat = fs.statSync(imagePath);
        exists = stat.isFile();
      } catch {
        exists = false;
      }
      image.imagePath = imagePath;
      image.imageExists = exists;
      image.imageBytes = exists ? stat.size : 0;
      if (!exists) issues.push({ page: page.image, reason: `图集页图片不存在: ${imagePath}` });
      else if (stat.size === 0) issues.push({ page: page.image, reason: '图集页图片是空文件' });
    }
    pages.push(image);
  }

  const duplicates = [];
  const seen = new Map();
  for (const item of names) {
    const key = `${item.name}:${item.index}`;
    if (seen.has(key)) duplicates.push({ name: item.name, index: item.index, pages: [seen.get(key), item.page] });
    else seen.set(key, item.page);
  }
  for (const duplicate of duplicates) issues.push({ ...duplicate, reason: `region 重名（name=${duplicate.name}, index=${duplicate.index}）` });

  return {
    source,
    pageCount: pages.length,
    regionCount: names.length,
    duplicateRegions: duplicates,
    issueCount: issues.length,
    issues,
    pages,
    note: '只做文本与文件存在性/几何校验，不解码图片内容。',
  };
}

function skeletonAttachmentUsage(skeleton) {
  const setup = new Set();
  const timeline = new Set();
  for (const slot of skeleton.slots ?? []) {
    if (typeof slot?.attachment === 'string') setup.add(slot.attachment);
  }
  for (const animation of Object.values(skeleton.animations ?? {})) {
    for (const slots of Object.values(animation.slots ?? {})) {
      for (const key of slots.attachment ?? []) {
        if (typeof key?.name === 'string') timeline.add(key.name);
      }
    }
  }
  const bySlot = new Map();
  const all = new Set([...setup, ...timeline]);
  for (const skin of Array.isArray(skeleton.skins) ? skeleton.skins : Object.values(skeleton.skins ?? {})) {
    const attachments = skin?.attachments ?? skin;
    for (const [slotName, items] of Object.entries(attachments ?? {})) {
      for (const [name, attachment] of Object.entries(items ?? {})) {
        if (!all.has(name)) continue;
        const row = bySlot.get(name) ?? { name, slots: new Set(), types: new Set(), imageSource: null };
        row.slots.add(slotName);
        if (isObject(attachment)) {
          row.types.add(attachment.type ?? 'region');
          // mesh 可以用 path 引用另一个图片名；图集匹配以 path 优先。
          if (typeof attachment.path === 'string' && attachment.path) row.imageSource = attachment.path;
          else if (row.imageSource === null) row.imageSource = name;
        }
        bySlot.set(name, row);
      }
    }
  }
  return { setup: [...setup], timeline: [...timeline], all: [...all].sort(), details: [...bySlot.values()].map((row) => ({ ...row, slots: [...row.slots], types: [...row.types] })) };
}

export function auditAssets({ skeleton, atlasReports = [], imageDir = null }) {
  if (!isObject(skeleton)) throw new Error('skeleton 必须是对象');
  const usage = skeletonAttachmentUsage(skeleton);
  const issues = [];
  const atlasNames = new Map();

  if (!Array.isArray(atlasReports)) throw new Error('atlasReports 必须是数组');
  for (const report of atlasReports) {
    for (const page of report.pages ?? []) {
      for (const region of page.regions ?? []) atlasNames.set(`${region.name}:${region.index}`, { name: region.name, page: page.page });
    }
    for (const issue of report.issues ?? []) issues.push({ source: report.source, ...issue });
  }

  const missingInAtlas = [];
  const attachmentLocations = new Map(usage.details.map((row) => [row.name, row]));
  const imageSources = new Set(usage.details.map((row) => row.imageSource).filter(Boolean));
  const checkAtlas = atlasReports.length > 0;
  for (const name of usage.all) {
    const row = attachmentLocations.get(name);
    const sourceName = row?.imageSource ?? name;
    const inAtlas = [...atlasNames.values()].some((item) => item.name === sourceName);
    if (checkAtlas && !inAtlas) {
      missingInAtlas.push({ attachment: name, region: sourceName });
      issues.push({ type: 'atlas.missingRegion', attachment: name, region: sourceName, reason: `附件在图集里没有对应 region: ${sourceName}` });
    }
    if (imageDir) {
      const candidates = ['.png', '.jpg', '.jpeg', '.webp', '.tga'].map((ext) => path.join(imageDir, `${sourceName}${ext}`));
      const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!found && (!checkAtlas || !inAtlas)) {
        issues.push({ type: 'image.missingFile', attachment: name, region: sourceName, reason: `源图片文件不存在，也没有图集 region 可兜底: ${sourceName}` });
      }
    }
  }

  const unusedRegions = [];
  if (checkAtlas) {
    for (const [key, item] of atlasNames) {
      if (!imageSources.has(item.name)) unusedRegions.push({ ...item, index: Number(key.split(':')[1]) });
    }
  }

  return {
    attachmentCount: usage.all.length,
    setupAttachments: usage.setup,
    timelineAttachments: usage.timeline,
    attachments: usage.details,
    atlasCount: atlasReports.length,
    atlasRegionCount: atlasNames.size,
    missingInAtlas,
    unusedRegions,
    issueCount: issues.length,
    issues,
    note: imageDir ? '图片目录校验只判断常见扩展名文件是否存在，不校验像素内容。' : '未提供 imageDir，跳过散图文件存在性检查。',
  };
}
