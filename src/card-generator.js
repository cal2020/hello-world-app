const occasionMessages = {
  birthday: 'Happy Birthday!',
  anniversary: 'Happy Anniversary!',
  'thank-you': 'Thank You!',
  congratulations: 'Congratulations!',
  holiday: 'Happy Holidays!',
  custom: 'Special Wishes'
}

// Gradient stops are kept as data so the same theme drives both the CSS
// preview and the canvas export.
const themes = {
  classic: {
    stops: ['#f5f7fa', '#c3cfe2'],
    headerColor: '#2c3e50',
    textColor: '#34495e',
    accentColor: '#3498db'
  },
  modern: {
    stops: ['#667eea', '#764ba2'],
    headerColor: '#ffffff',
    textColor: '#f8f9fa',
    accentColor: '#ffd700'
  },
  elegant: {
    stops: ['#ffecd2', '#fcb69f'],
    headerColor: '#8b4513',
    textColor: '#5d4037',
    accentColor: '#ff6b6b'
  },
  playful: {
    stops: ['#a8edea', '#fed6e3'],
    headerColor: '#e91e63',
    textColor: '#4a148c',
    accentColor: '#ff9800'
  }
}

const DEFAULTS = {
  recipient: 'Someone Special',
  sender: 'Anonymous',
  message: 'Your message will appear here...'
}

const FONT_STACK = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// Splits text into lines that fit maxWidth, honouring explicit newlines and
// breaking words that are longer than a whole line.
function wrapText(ctx, text, maxWidth) {
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      line = ''
      let rest = word
      while (ctx.measureText(rest).width > maxWidth) {
        let cut = rest.length - 1
        while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxWidth) cut--
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      line = rest
    }
    lines.push(line)
  }
  return lines
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function setupCardGenerator() {
  const recipientInput = document.querySelector('#recipient')
  const senderInput = document.querySelector('#sender')
  const occasionSelect = document.querySelector('#occasion')
  const customTitleGroup = document.querySelector('#custom-title-group')
  const customTitleInput = document.querySelector('#custom-title')
  const messageTextarea = document.querySelector('#message')
  const messageCount = document.querySelector('#message-count')
  const themeSelect = document.querySelector('#theme')
  const cardPreview = document.querySelector('#card-preview')
  const downloadBtn = document.querySelector('#download-btn')
  const resetBtn = document.querySelector('#reset-btn')

  function getCardData() {
    const occasion = occasionSelect.value
    const customTitle = customTitleInput.value.trim()
    return {
      title: occasion === 'custom' && customTitle ? customTitle : occasionMessages[occasion],
      recipient: recipientInput.value.trim() || DEFAULTS.recipient,
      sender: senderInput.value.trim() || DEFAULTS.sender,
      message: messageTextarea.value.trim() || DEFAULTS.message,
      theme: themes[themeSelect.value]
    }
  }

  function updateCardPreview() {
    const { title, recipient, sender, message, theme } = getCardData()

    customTitleGroup.hidden = occasionSelect.value !== 'custom'
    messageCount.textContent = `${messageTextarea.value.length}/${messageTextarea.maxLength}`

    // Build with textContent so user input is never interpreted as HTML.
    const card = el('div', 'card-content')
    card.style.setProperty('--card-bg', `linear-gradient(135deg, ${theme.stops[0]} 0%, ${theme.stops[1]} 100%)`)
    card.style.setProperty('--card-header', theme.headerColor)
    card.style.setProperty('--card-text', theme.textColor)
    card.style.setProperty('--card-accent', theme.accentColor)

    const header = el('div', 'card-header')
    header.append(el('span', 'occasion-text', title))

    const recipientBlock = el('div', 'card-recipient')
    recipientBlock.append(el('h3', null, `Dear ${recipient},`))

    const messageBlock = el('div', 'card-message')
    messageBlock.append(el('p', null, message))

    const footer = el('div', 'card-footer')
    const from = el('span', 'card-from')
    from.append('With love,', el('br'), sender)
    footer.append(from)

    card.append(header, recipientBlock, messageBlock, footer)
    cardPreview.replaceChildren(card)
  }

  function resetForm() {
    recipientInput.value = ''
    senderInput.value = ''
    occasionSelect.value = 'birthday'
    customTitleInput.value = ''
    messageTextarea.value = ''
    themeSelect.value = 'classic'
    updateCardPreview()
  }

  function downloadCard() {
    const { title, recipient, sender, message, theme } = getCardData()

    // Same 3:4 proportions as the preview, rendered at 2x for a crisp image.
    const width = 600
    const height = 800
    const scale = 2
    const pad = 48

    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)

    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, theme.stops[0])
    gradient.addColorStop(1, theme.stops[1])
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.roundRect(0, 0, width, height, 32)
    ctx.fill()

    const contentWidth = width - pad * 2
    ctx.textBaseline = 'top'

    ctx.fillStyle = theme.accentColor
    ctx.font = `bold 44px ${FONT_STACK}`
    ctx.textAlign = 'center'
    let y = pad
    for (const line of wrapText(ctx, title, contentWidth)) {
      ctx.fillText(line, width / 2, y)
      y += 54
    }

    ctx.fillStyle = theme.headerColor
    ctx.font = `600 28px ${FONT_STACK}`
    ctx.textAlign = 'left'
    y += 24
    for (const line of wrapText(ctx, `Dear ${recipient},`, contentWidth)) {
      ctx.fillText(line, pad, y)
      y += 36
    }

    const footerTop = height - pad - 60
    const messageTop = y + 16

    ctx.fillStyle = theme.textColor
    ctx.font = `italic 24px ${FONT_STACK}`
    ctx.textAlign = 'center'
    const lineHeight = 36
    const maxLines = Math.floor((footerTop - 16 - messageTop) / lineHeight)
    let lines = wrapText(ctx, message, contentWidth)
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines)
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s*\S{0,3}$/, '')}…`
    }
    const messageHeight = lines.length * lineHeight
    y = messageTop + (footerTop - 16 - messageTop - messageHeight) / 2
    for (const line of lines) {
      ctx.fillText(line, width / 2, y)
      y += lineHeight
    }

    ctx.fillStyle = theme.textColor
    ctx.globalAlpha = 0.85
    ctx.font = `20px ${FONT_STACK}`
    ctx.textAlign = 'right'
    ctx.fillText('With love,', width - pad, footerTop)
    ctx.fillText(sender, width - pad, footerTop + 28)
    ctx.globalAlpha = 1

    const link = document.createElement('a')
    link.download = `greeting-card-${slugify(recipient) || 'card'}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  recipientInput.addEventListener('input', updateCardPreview)
  senderInput.addEventListener('input', updateCardPreview)
  occasionSelect.addEventListener('change', updateCardPreview)
  customTitleInput.addEventListener('input', updateCardPreview)
  messageTextarea.addEventListener('input', updateCardPreview)
  themeSelect.addEventListener('change', updateCardPreview)

  downloadBtn.addEventListener('click', downloadCard)
  resetBtn.addEventListener('click', resetForm)

  updateCardPreview()
}
