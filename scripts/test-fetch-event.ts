import dotenv from 'dotenv';
dotenv.config();

import { fetchEvent } from '../src/scrapers/event';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: tsx scripts/test-fetch-event.ts <eventId>');
    process.exit(1);
  }
  const eventId = arg;
  try {
    console.log('Fetching event', eventId);
    const res = await fetchEvent(eventId as any);
    console.log('Response:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Error during fetchEvent:', err?.stack || err);
    process.exit(2);
  }
}

main();
