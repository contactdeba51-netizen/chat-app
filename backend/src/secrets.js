// Secrets are resolved once and validated at startup.
//
// Production must fail closed: a missing or short secret used to fall back to a
// value printed in this repository, which would let anyone forge sessions,
// media links, and locked-chat unlock tokens. Development keeps a throwaway
// fallback so a fresh clone still runs before .env is filled in.
const isProduction = () => process.env.NODE_ENV === 'production'

const MIN_SECRET_LENGTH = 32
const DEV_JWT_SECRET = 'chat-app-dev-jwt-secret-not-for-production'
const DEV_MEDIA_SECRET = 'chat-app-dev-media-secret-not-for-production'

let cachedJwt = ''
let cachedMedia = ''

function read(name) {
  return String(process.env[name] || '').trim()
}

function jwtSecret() {
  if (cachedJwt) return cachedJwt
  const value = read('JWT_SECRET')
  if (!value) {
    if (isProduction()) throw new Error('JWT_SECRET is not configured.')
    cachedJwt = DEV_JWT_SECRET
    return cachedJwt
  }
  cachedJwt = value
  return cachedJwt
}

function mediaSecret() {
  if (cachedMedia) return cachedMedia
  const value = read('MEDIA_SECRET')
  if (value) {
    cachedMedia = value
    return cachedMedia
  }
  if (isProduction()) throw new Error('MEDIA_SECRET is not configured.')
  // Locally a single secret is fine; production requires a separate value.
  cachedMedia = read('JWT_SECRET') || DEV_MEDIA_SECRET
  return cachedMedia
}

// Returns every reason the production configuration is unsafe, so the operator
// sees all of them at once instead of fixing one per restart.
function productionProblems() {
  if (!isProduction()) return []
  const problems = []
  const jwt = read('JWT_SECRET')
  const media = read('MEDIA_SECRET')

  if (!jwt) problems.push('JWT_SECRET is missing.')
  else if (jwt.length < MIN_SECRET_LENGTH) problems.push(`JWT_SECRET is ${jwt.length} characters; use at least ${MIN_SECRET_LENGTH}.`)

  if (!media) problems.push('MEDIA_SECRET is missing. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"')
  else if (media.length < MIN_SECRET_LENGTH) problems.push(`MEDIA_SECRET is ${media.length} characters; use at least ${MIN_SECRET_LENGTH}.`)

  if (jwt && media && jwt === media) problems.push('MEDIA_SECRET must be different from JWT_SECRET.')

  return problems
}

function assertProductionSecrets() {
  const problems = productionProblems()
  if (!problems.length) return
  console.error('Refusing to start: the production environment is not configured safely.')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('Set the variables above in the hosting dashboard, then redeploy.')
  process.exit(1)
}

module.exports = { jwtSecret, mediaSecret, assertProductionSecrets, productionProblems, MIN_SECRET_LENGTH }
