/**
 * Test bootstrap.
 *
 * Loads `.env` when one exists so the server's integration suite finds
 * DATABASE_URL and the JWT secrets locally. In CI those come from the job's
 * `env:` block instead and there is no `.env` to find, so this is a no-op
 * there — deliberately quiet rather than throwing, because the client-side
 * suites need none of it.
 */
import { existsSync } from 'node:fs'
import { config } from 'dotenv'

if (existsSync('.env')) config({ path: '.env', quiet: true })
