# Starts the portable PostgreSQL server used by this project.
$pgRoot = Join-Path $env:USERPROFILE 'pgsql'
$bin = Join-Path $pgRoot '17\bin'
$data = Join-Path $pgRoot 'data'
$log = Join-Path $pgRoot 'postgres.log'

if (-not (Test-Path (Join-Path $bin 'pg_ctl.exe'))) {
  throw "PostgreSQL binaries were not found at $bin. Re-run the database setup first."
}

& (Join-Path $bin 'pg_ctl.exe') -D $data -l $log start
