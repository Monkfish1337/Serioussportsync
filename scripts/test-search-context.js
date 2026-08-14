const assert = require('assert');
const store = require('../lib/store');
const promotions = require('../lib/promotions');

store.getEvent = () => ({
  id: 'nba:12345',
  promotion: 'nba',
  name: 'Dallas Mavericks vs Chicago Bulls',
  date: '2026-04-12',
  aliases: ['Chicago Bulls @ Dallas Mavericks'],
  searchAliases: ['NBA Mavericks Bulls'],
});
promotions.getByEventId = () => ({
  id: 'nba',
  sport: 'Basketball',
  searchTitles: () => [
    'Dallas Mavericks vs Chicago Bulls',
    'Dallas Mavericks vs Chicago Bulls 2026',
  ],
});

const { handleSearchContext } = require('../lib/search-context');
const context = handleSearchContext({ type: 'movie', id: 'nba:12345' });

assert(context);
assert.strictEqual(context.year, 2026);
assert(context.searchTitles.includes('Chicago Bulls @ Dallas Mavericks'));
assert(context.searchTitles.includes('Dallas Mavericks vs Chicago Bulls 2026'));
assert.strictEqual(
  handleSearchContext({ type: 'series', id: 'nba:12345' }),
  null
);

console.log('SeriousSportSync search-context test passed');
