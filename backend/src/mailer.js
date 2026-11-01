const { Resend } = require('resend')

const BREVO_API_KEY = process.env.BREVO_API_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM = process.env.EMAIL_FROM || ''
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Chat App'
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

function senderAddress() {
  const match = FROM.match(/<([^>]+)>/)
  return (match ? match[1] : FROM).trim()
}

// Turn a Brevo rejection into something the person at the keyboard can act on.
function brevoHint(details) {
  let message = ''
  try { message = JSON.parse(details).message || '' } catch { message = '' }
  if (!message) return ''
  const ip = message.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
  if (/unrecognised IP|not authorized|authorised_ips/i.test(message)) {
    return `Brevo blocked this computer's IP address${ip ? ` (${ip})` : ''}. Authorize it at https://app.brevo.com/security/authorised_ips and try again.`
  }
  if (/sender/i.test(message) && /not valid|invalid|verified/i.test(message)) {
    return `Brevo rejected the sender "${senderAddress()}". Verify that address under Senders & Domains in Brevo.`
  }
  if (/permission_denied|not authorized for resource/i.test(message)) {
    return 'The Brevo API key is missing permission for transactional emails. Create a key with full access.'
  }
  return message.slice(0, 200)
}

function isConfigured() {
  return Boolean(senderAddress() && (BREVO_API_KEY || RESEND_API_KEY))
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured()) {
    const error = new Error('Email delivery is not configured. Add BREVO_API_KEY and EMAIL_FROM to backend/.env.')
    error.status = 503
    throw error
  }

  if (BREVO_API_KEY) {
    let response
    try {
      response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: senderAddress(), name: FROM_NAME },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text || undefined,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (cause) {
      console.error('Brevo email request failed:', cause.message)
      const error = new Error('The email provider could not be reached. Check this computer\'s internet connection and try again.')
      error.status = 502
      throw error
    }
    if (!response.ok) {
      const details = await response.text().catch(() => '')
      console.error('Brevo email failed:', response.status, details.slice(0, 300))
      const error = new Error(brevoHint(details) || 'The verification email could not be sent. Please try again shortly.')
      error.status = 502
      throw error
    }
    return
  }

  let resendResult
  try {
    resendResult = await resend.emails.send({ from: FROM, to, subject, html })
  } catch (cause) {
    console.error('Resend request failed:', cause.message)
    const error = new Error('The email provider could not be reached. Check this computer\'s internet connection and try again.')
    error.status = 502
    throw error
  }
  const { error: resendError } = resendResult
  if (resendError) {
    console.error('Resend email failed:', resendError.message)
    const error = new Error(`Resend rejected the message: ${resendError.message}`)
    error.status = 502
    throw error
  }
}

module.exports = { sendMail, isConfigured }
