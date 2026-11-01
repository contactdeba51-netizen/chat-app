// Checks the email configuration and sends one real test message.
// Run: npm run mail:test -- you@example.com
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { sendMail, isConfigured } = require('../src/mailer')

async function main() {
  const to = process.argv[2]
  const from = process.env.EMAIL_FROM || ''
  const provider = process.env.BREVO_API_KEY ? 'Brevo' : process.env.RESEND_API_KEY ? 'Resend' : 'none'

  console.log(`Provider : ${provider}`)
  console.log(`Sender   : ${from || '(missing EMAIL_FROM)'}`)

  if (!isConfigured()) {
    console.error('\nEmail is NOT configured. Add BREVO_API_KEY and EMAIL_FROM to backend/.env, then run this again.')
    process.exit(1)
  }
  if (!to) {
    console.error('\nConfiguration looks usable. Pass a destination address: npm run mail:test -- you@example.com')
    process.exit(1)
  }

  try {
    await sendMail({
      to,
      subject: 'Chat App email test',
      text: 'If you can read this, Chat App can deliver verification codes.',
      html: '<p>If you can read this, Chat App can deliver verification codes.</p>',
    })
    console.log(`\nSent. Check ${to} (and the spam folder) for a test message.`)
  } catch (error) {
    console.error(`\nDelivery failed: ${error.message}`)
    process.exit(1)
  }
}

main()
