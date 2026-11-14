import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export const MAX_RESUME_BYTES = 8 * 1024 * 1024
export const MAX_RESUME_TEXT = 8_000

export interface ParsedResume {
  text: string
  truncated: boolean
}

function normalizeText(value: string): string {
  return value
    .replaceAll(String.fromCharCode(0), '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readPdf(file: File): Promise<{ text: string; truncated: boolean }> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  try {
    const document = await loadingTask.promise
    const pages = Math.min(document.numPages, 40)
    let truncated = document.numPages > pages
    const chunks: string[] = []
    let length = 0
    for (let index = 1; index <= pages; index += 1) {
      const page = await document.getPage(index)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item) => 'str' in item && typeof item.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' ')
      chunks.push(pageText)
      length += pageText.length
      if (length > MAX_RESUME_TEXT) { truncated = true; break }
    }
    return { text: chunks.join('\n'), truncated }
  } finally {
    await loadingTask.destroy()
  }
}

/** Extract text locally in the browser; the original file is never uploaded. */
export async function parseResume(file: File): Promise<ParsedResume> {
  if (file.size > MAX_RESUME_BYTES) throw new Error('简历文件不能超过 8 MB。')
  if (!file.size) throw new Error('这个文件没有内容，请选择另一份简历。')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!['txt', 'pdf', 'docx'].includes(extension || '')) {
    throw new Error('仅支持 PDF、DOCX 或 TXT 格式的简历。')
  }

  let content: string
  let truncated = false
  try {
    if (extension === 'pdf') {
      const result = await readPdf(file)
      content = result.text
      truncated = result.truncated
    } else if (extension === 'docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
      content = result.value
    } else {
      content = await file.text()
    }
  } catch {
    throw new Error('无法读取简历文本。请确认文件未加密或损坏，也可以改用 TXT 格式。')
  }

  const normalized = normalizeText(content)
  if (!normalized) throw new Error('没有提取到可读文字。扫描版 PDF 请先进行 OCR，或改用 DOCX/TXT。')
  truncated ||= normalized.length > MAX_RESUME_TEXT
  return { text: normalized.slice(0, MAX_RESUME_TEXT), truncated }
}
