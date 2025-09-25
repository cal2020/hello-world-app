const occasionMessages = {
  birthday: "Happy Birthday!",
  anniversary: "Happy Anniversary!",
  "thank-you": "Thank You!",
  congratulations: "Congratulations!",
  holiday: "Happy Holidays!",
  custom: "Special Wishes"
}

const themes = {
  classic: {
    background: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
    headerColor: '#2c3e50',
    textColor: '#34495e',
    accentColor: '#3498db'
  },
  modern: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    headerColor: '#ffffff',
    textColor: '#f8f9fa',
    accentColor: '#ffd700'
  },
  elegant: {
    background: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
    headerColor: '#8b4513',
    textColor: '#5d4037',
    accentColor: '#ff6b6b'
  },
  playful: {
    background: 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
    headerColor: '#e91e63',
    textColor: '#4a148c',
    accentColor: '#ff9800'
  }
}

export function setupCardGenerator() {
  const recipientInput = document.querySelector('#recipient')
  const senderInput = document.querySelector('#sender')
  const occasionSelect = document.querySelector('#occasion')
  const messageTextarea = document.querySelector('#message')
  const themeSelect = document.querySelector('#theme')
  const cardPreview = document.querySelector('#card-preview')
  const downloadBtn = document.querySelector('#download-btn')
  const resetBtn = document.querySelector('#reset-btn')

  function updateCardPreview() {
    const recipient = recipientInput.value || 'Someone Special'
    const sender = senderInput.value || 'Anonymous'
    const occasion = occasionSelect.value
    const message = messageTextarea.value || 'Your message will appear here...'
    const theme = themeSelect.value

    const occasionText = occasionMessages[occasion]
    const themeData = themes[theme]

    const cardContent = `
      <div class="card-content ${theme}-theme">
        <div class="card-header">
          <span class="occasion-text">${occasionText}</span>
        </div>
        <div class="card-recipient">
          <h3>Dear ${recipient},</h3>
        </div>
        <div class="card-message">
          <p>${message}</p>
        </div>
        <div class="card-footer">
          <span class="card-from">With love,<br>${sender}</span>
        </div>
      </div>
    `

    cardPreview.innerHTML = cardContent

    const cardContentEl = cardPreview.querySelector('.card-content')
    cardContentEl.style.background = themeData.background
    cardContentEl.style.color = themeData.textColor

    const headerEl = cardPreview.querySelector('.card-header')
    if (headerEl) {
      headerEl.style.color = themeData.headerColor
    }

    const occasionEl = cardPreview.querySelector('.occasion-text')
    if (occasionEl) {
      occasionEl.style.color = themeData.accentColor
    }
  }

  function resetForm() {
    recipientInput.value = ''
    senderInput.value = ''
    occasionSelect.value = 'birthday'
    messageTextarea.value = ''
    themeSelect.value = 'classic'
    updateCardPreview()
  }

  function downloadCard() {
    const cardElement = document.querySelector('.card-content')

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = 400
    canvas.height = 300

    const recipient = recipientInput.value || 'Someone Special'
    const sender = senderInput.value || 'Anonymous'
    const occasion = occasionSelect.value
    const message = messageTextarea.value || 'Your message will appear here...'

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.fillStyle = '#333333'
    ctx.font = 'bold 24px Arial'
    ctx.textAlign = 'center'
    ctx.fillText(occasionMessages[occasion], canvas.width / 2, 50)

    ctx.font = '16px Arial'
    ctx.fillText(`Dear ${recipient},`, canvas.width / 2, 100)

    const lines = message.split('\n')
    lines.forEach((line, index) => {
      ctx.fillText(line, canvas.width / 2, 140 + (index * 20))
    })

    ctx.fillText(`With love, ${sender}`, canvas.width / 2, 250)

    const link = document.createElement('a')
    link.download = 'greeting-card.png'
    link.href = canvas.toDataURL()
    link.click()
  }

  recipientInput.addEventListener('input', updateCardPreview)
  senderInput.addEventListener('input', updateCardPreview)
  occasionSelect.addEventListener('change', updateCardPreview)
  messageTextarea.addEventListener('input', updateCardPreview)
  themeSelect.addEventListener('change', updateCardPreview)

  downloadBtn.addEventListener('click', downloadCard)
  resetBtn.addEventListener('click', resetForm)

  updateCardPreview()
}