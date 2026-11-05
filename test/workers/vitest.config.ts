import { OLDEST_COMPATIBILITY_DATE, workersProject } from './project.js'

// The Durable Object at the oldest compatibility date any consumer runs it under (wrangler.jsonc's own date).
export default workersProject('workers', OLDEST_COMPATIBILITY_DATE)
