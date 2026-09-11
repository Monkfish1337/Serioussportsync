// 0.42.6 — Baked-in team-alias tables for football promotions.
//
// The scraper builds a bidirectional lookup at promotion-load time
// (buildAliasLookup in promotions.js) so every ALIAS in the list also becomes
// a lookup key. That means the incoming team name can be in ANY form and the
// scraper will find the full alias set:
//   - football-data.org `name`      ("Manchester United FC")
//   - football-data.org `shortName` ("Man United")   ← what SSS actually gets
//   - football-data.org `tla`       ("MUN")
//   - Common release-group forms   ("Man Utd", "MUFC", "United")
//   - First-word only              ("Manchester" — hits DARKSPORT-style
//                                    "EPL YYYY MM DD Manchester Vs ..."
//                                    releases which use the first word only)
//
// Each entry's alias list should include ALL of the above where known, plus
// every common variant release groups actually use. Adding more aliases is
// nearly free — they enlarge the search-query fan-out slightly but massively
// increase hit rate.

// -----------------------------------------------------------------
// EPL 2025-26 season — every club.
// (Refreshed 2026-07: Leicester/Ipswich/Southampton relegated;
// Leeds/Burnley/Sunderland promoted from Championship.)
// -----------------------------------------------------------------
const EPL = {
  'Arsenal FC': [
    'Arsenal', 'ARS', 'AFC', 'Gunners',
  ],
  'Aston Villa FC': [
    'Aston Villa', 'AVL', 'Villa', 'AVFC', 'Aston',
  ],
  'AFC Bournemouth': [
    'Bournemouth', 'BOU', 'AFCB', 'Cherries',
  ],
  'Brentford FC': [
    'Brentford', 'BRE', 'BFC', 'Bees',
  ],
  'Brighton & Hove Albion FC': [
    'Brighton Hove Albion', 'Brighton & Hove Albion',
    'Brighton and Hove Albion', 'Brighton Hove',
    'Brighton', 'BHA', 'Seagulls',
  ],
  'Burnley FC': [
    'Burnley', 'BUR', 'BFC', 'Clarets',
  ],
  'Chelsea FC': [
    'Chelsea', 'CHE', 'CFC', 'Blues',
  ],
  'Crystal Palace FC': [
    'Crystal Palace', 'CRY', 'CPFC', 'Palace', 'Crystal', 'Eagles',
  ],
  'Everton FC': [
    'Everton', 'EVE', 'EFC', 'Toffees',
  ],
  'Fulham FC': [
    'Fulham', 'FUL', 'FFC', 'Cottagers',
  ],
  'Leeds United FC': [
    'Leeds United', 'Leeds', 'LEE', 'LUFC', 'Whites',
  ],
  'Liverpool FC': [
    'Liverpool', 'LIV', 'LFC', 'Reds',
  ],
  'Manchester City FC': [
    'Manchester City', 'Man City', 'MCI', 'MCFC', 'Man.City', 'City',
    'Manchester', 'Cityzens', 'Sky Blues',
  ],
  'Manchester United FC': [
    'Manchester United', 'Man United', 'Man Utd', 'MUN', 'MUFC',
    'Man.United', 'Man.Utd', 'Manchester', 'United', 'Red Devils',
  ],
  'Newcastle United FC': [
    'Newcastle United', 'Newcastle', 'NEW', 'NUFC', 'Magpies',
    'Toon', 'Toon Army',
  ],
  'Nottingham Forest FC': [
    'Nottingham Forest', 'Forest', 'NFO', 'NFFC', 'Nottingham',
    'Nottm Forest', 'Nottm', 'Tricky Trees',
  ],
  'Sunderland AFC': [
    'Sunderland', 'SUN', 'SAFC', 'Black Cats',
  ],
  'Tottenham Hotspur FC': [
    'Tottenham Hotspur', 'Tottenham', 'Spurs', 'TOT', 'THFC',
    'Hotspur', 'Lilywhites',
  ],
  'West Ham United FC': [
    'West Ham United', 'West Ham', 'WHU', 'WHUFC', 'Hammers',
    'Irons',
  ],
  'Wolverhampton Wanderers FC': [
    'Wolverhampton Wanderers', 'Wolverhampton', 'Wolves', 'WOL', 'WWFC',
  ],
};

// -----------------------------------------------------------------
// EFL Championship 2025-26 — full 24-club table.
// (Reflects Leicester/Ipswich/Southampton dropping in, Leeds/Burnley/
// Sunderland promoted out, Charlton/Wrexham/Derby promoted from L1.)
// -----------------------------------------------------------------
const CHAMPIONSHIP = {
  'Birmingham City FC': [
    'Birmingham City', 'Birmingham', 'BIR', 'BCFC', 'Blues',
  ],
  'Blackburn Rovers FC': [
    'Blackburn Rovers', 'Blackburn', 'BLA', 'BRFC', 'Rovers',
  ],
  'Bristol City FC': [
    'Bristol City', 'BRI', 'BCFC', 'Robins', 'Bristol',
  ],
  'Charlton Athletic FC': [
    'Charlton Athletic', 'Charlton', 'CHA', 'CAFC', 'Addicks',
  ],
  'Coventry City FC': [
    'Coventry City', 'Coventry', 'COV', 'CCFC', 'Sky Blues',
  ],
  'Derby County FC': [
    'Derby County', 'Derby', 'DER', 'DCFC', 'Rams',
  ],
  'Hull City AFC': [
    'Hull City', 'Hull', 'HUL', 'HCAFC', 'Tigers',
  ],
  'Ipswich Town FC': [
    'Ipswich Town', 'Ipswich', 'IPS', 'ITFC', 'Tractor Boys', 'Blues',
  ],
  'Leicester City FC': [
    'Leicester City', 'Leicester', 'LEI', 'LCFC', 'Foxes',
  ],
  'Middlesbrough FC': [
    'Middlesbrough', 'Boro', 'MID', 'MFC',
  ],
  'Millwall FC': [
    'Millwall', 'MIL', 'MFC', 'Lions',
  ],
  'Norwich City FC': [
    'Norwich City', 'Norwich', 'NOR', 'NCFC', 'Canaries',
  ],
  'Oxford United FC': [
    'Oxford United', 'Oxford', 'OXF', 'OUFC', 'Us',
  ],
  'Portsmouth FC': [
    'Portsmouth', 'POR', 'PFC', 'Pompey',
  ],
  'Preston North End FC': [
    'Preston North End', 'Preston', 'PRE', 'PNE', 'Lilywhites',
  ],
  'Queens Park Rangers FC': [
    'Queens Park Rangers', 'QPR', 'Rangers', 'Hoops',
  ],
  'Sheffield United FC': [
    'Sheffield United', 'Sheff United', 'Sheff Utd', 'SHU', 'SUFC',
    'Sheffield', 'Blades',
  ],
  'Sheffield Wednesday FC': [
    'Sheffield Wednesday', 'Sheff Wednesday', 'Sheff Wed', 'SHW', 'SWFC',
    'Wednesday', 'Owls',
  ],
  'Southampton FC': [
    'Southampton', 'SOU', 'SFC', 'Saints',
  ],
  'Stoke City FC': [
    'Stoke City', 'Stoke', 'STO', 'SCFC', 'Potters',
  ],
  'Swansea City AFC': [
    'Swansea City', 'Swansea', 'SWA', 'SCFC', 'Swans',
  ],
  'Watford FC': [
    'Watford', 'WAT', 'WFC', 'Hornets',
  ],
  'West Bromwich Albion FC': [
    'West Bromwich Albion', 'West Brom', 'WBA', 'WBAFC', 'Baggies',
    'Bromwich',
  ],
  'Wrexham AFC': [
    'Wrexham', 'WRE', 'WAFC', 'Red Dragons',
  ],
};

// -----------------------------------------------------------------
// EFL League One 2025-26 — full 24-club table.
// -----------------------------------------------------------------
const LEAGUE_ONE = {
  'AFC Wimbledon': [
    'AFC Wimbledon', 'Wimbledon', 'WIM', 'AFCW', 'Dons',
  ],
  'Barnsley FC': [
    'Barnsley', 'BAR', 'BFC', 'Tykes',
  ],
  'Blackpool FC': [
    'Blackpool', 'BLA', 'BFC', 'Seasiders', 'Tangerines',
  ],
  'Bolton Wanderers FC': [
    'Bolton Wanderers', 'Bolton', 'BOL', 'BWFC', 'Trotters',
  ],
  'Bradford City AFC': [
    'Bradford City', 'Bradford', 'BRA', 'BCAFC', 'Bantams',
  ],
  'Burton Albion FC': [
    'Burton Albion', 'Burton', 'BUR', 'BAFC', 'Brewers',
  ],
  'Cardiff City FC': [
    'Cardiff City', 'Cardiff', 'CAR', 'CCFC', 'Bluebirds',
  ],
  'Doncaster Rovers FC': [
    'Doncaster Rovers', 'Doncaster', 'DON', 'DRFC', 'Rovers',
  ],
  'Exeter City FC': [
    'Exeter City', 'Exeter', 'EXE', 'ECFC', 'Grecians',
  ],
  'Huddersfield Town AFC': [
    'Huddersfield Town', 'Huddersfield', 'HUD', 'HTAFC', 'Terriers',
  ],
  'Leyton Orient FC': [
    'Leyton Orient', 'Orient', 'LEY', 'LOFC', 'The O\'s',
  ],
  'Lincoln City FC': [
    'Lincoln City', 'Lincoln', 'LIN', 'LCFC', 'Imps',
  ],
  'Luton Town FC': [
    'Luton Town', 'Luton', 'LUT', 'LTFC', 'Hatters',
  ],
  'Mansfield Town FC': [
    'Mansfield Town', 'Mansfield', 'MAN', 'MTFC', 'Stags',
  ],
  'Northampton Town FC': [
    'Northampton Town', 'Northampton', 'NOR', 'NTFC', 'Cobblers',
  ],
  'Peterborough United FC': [
    'Peterborough United', 'Peterborough', 'PET', 'PUFC', 'Posh',
  ],
  'Plymouth Argyle FC': [
    'Plymouth Argyle', 'Plymouth', 'PLY', 'PAFC', 'Pilgrims',
  ],
  'Port Vale FC': [
    'Port Vale', 'PV', 'PVFC', 'Valiants',
  ],
  'Reading FC': [
    'Reading', 'REA', 'RFC', 'Royals',
  ],
  'Rotherham United FC': [
    'Rotherham United', 'Rotherham', 'ROT', 'RUFC', 'Millers',
  ],
  'Stevenage FC': [
    'Stevenage', 'STE', 'SFC', 'Boro',
  ],
  'Stockport County FC': [
    'Stockport County', 'Stockport', 'STK', 'SCFC', 'Hatters',
  ],
  'Wigan Athletic FC': [
    'Wigan Athletic', 'Wigan', 'WIG', 'WAFC', 'Latics',
  ],
  'Wycombe Wanderers FC': [
    'Wycombe Wanderers', 'Wycombe', 'WYC', 'WWFC', 'Chairboys',
  ],
};

// EFL = EPL + Championship + League One combined. Handy for a single preset
// choice that covers every English tier a football-data.org promotion might
// touch (e.g. FA Cup fixtures across all tiers).
const EFL = { ...EPL, ...CHAMPIONSHIP, ...LEAGUE_ONE };

// -----------------------------------------------------------------
// UCL — top European clubs plus every EPL club (they all qualify at
// some point). Reasonable coverage for the CL group + knockout stages.
// -----------------------------------------------------------------
const UCL = {
  // Spread EPL — all top-4 finishers in the current EPL and traditional
  // top clubs periodically qualify.
  ...EPL,

  // La Liga
  'Real Madrid CF': [
    'Real Madrid', 'RMA', 'Madrid', 'Los Blancos', 'Real',
  ],
  'FC Barcelona': [
    'Barcelona', 'FCB', 'Barca', 'Barça', 'Blaugrana',
  ],
  'Atletico Madrid': [
    'Atletico', 'Atletico de Madrid', 'Atleti', 'ATM',
    'Atlético Madrid', 'Atlético de Madrid', 'Atlético',
  ],
  'Athletic Club': [
    'Athletic Bilbao', 'Athletic', 'Bilbao', 'ATH',
  ],
  'Real Sociedad de Futbol': [
    'Real Sociedad', 'Sociedad', 'RSO', 'La Real',
  ],
  'Villarreal CF': [
    'Villarreal', 'VIL', 'Yellow Submarine',
  ],
  'Sevilla FC': [
    'Sevilla', 'SEV', 'SFC',
  ],
  'Real Betis Balompie': [
    'Real Betis', 'Betis', 'BET',
  ],
  'Girona FC': [
    'Girona', 'GIR',
  ],

  // Bundesliga
  'Bayern Munchen': [
    'Bayern', 'Bayern Munich', 'FC Bayern', 'FC Bayern Munchen',
    'FC Bayern München', 'FCB Bayern', 'BAY',
  ],
  'Borussia Dortmund': [
    'Dortmund', 'BVB', 'BVB 09', 'BVB Dortmund', 'DOR',
  ],
  'Bayer 04 Leverkusen': [
    'Bayer Leverkusen', 'Leverkusen', 'Bayer 04', 'B04', 'LEV',
  ],
  'RB Leipzig': [
    'Leipzig', 'Red Bull Leipzig', 'RB Leipzig', 'RBL', 'LEI',
  ],
  'VfB Stuttgart': [
    'Stuttgart', 'VfB', 'STU',
  ],
  'Eintracht Frankfurt': [
    'Frankfurt', 'Eintracht', 'SGE', 'FRA',
  ],

  // Serie A
  'FC Internazionale Milano': [
    'Inter', 'Inter Milan', 'Internazionale', 'FC Internazionale', 'INT',
  ],
  'AC Milan': [
    'Milan', 'Milan AC', 'ACM', 'MIL',
  ],
  'Juventus FC': [
    'Juventus', 'Juve', 'JUV', 'JFC', 'La Vecchia Signora',
  ],
  'SSC Napoli': [
    'Napoli', 'SSC Napoli', 'NAP', 'SSC',
  ],
  'AS Roma': [
    'Roma', 'ASR', 'AS Roma', 'ROM',
  ],
  'SS Lazio': [
    'Lazio', 'SS Lazio', 'LAZ',
  ],
  'Atalanta BC': [
    'Atalanta', 'ATA', 'La Dea',
  ],
  'Bologna FC 1909': [
    'Bologna', 'BOL', 'FC Bologna',
  ],

  // Ligue 1
  'Paris Saint-Germain FC': [
    'Paris Saint-Germain', 'PSG', 'Paris SG', 'Paris', 'Parisiens',
  ],
  'AS Monaco FC': [
    'Monaco', 'ASM', 'AS Monaco',
  ],
  'Olympique Lyonnais': [
    'Lyon', 'OL', 'Olympique Lyon', 'OLY',
  ],
  'Olympique de Marseille': [
    'Marseille', 'OM', 'Olympique Marseille',
  ],
  'LOSC Lille': [
    'Lille', 'LOSC', 'LIL',
  ],

  // Portugal / Netherlands / Belgium / etc.
  'Sport Lisboa e Benfica': [
    'Benfica', 'SL Benfica', 'BEN',
  ],
  'Sporting Clube de Portugal': [
    'Sporting CP', 'Sporting', 'Sporting Lisbon', 'SCP',
  ],
  'Futebol Clube do Porto': [
    'Porto', 'FC Porto', 'POR',
  ],
  'PSV Eindhoven': [
    'PSV', 'Eindhoven', 'PSV Eindhoven',
  ],
  'AFC Ajax': [
    'Ajax', 'AJA',
  ],
  'Feyenoord Rotterdam': [
    'Feyenoord', 'FEY',
  ],
  'Club Brugge KV': [
    'Club Brugge', 'Brugge', 'CLU',
  ],
  'Royal Antwerp FC': [
    'Antwerp', 'Royal Antwerp', 'ANT',
  ],
  'Celtic FC': [
    'Celtic', 'CEL', 'Celts',
  ],
  'Rangers FC': [
    'Rangers', 'Glasgow Rangers', 'RAN',
  ],
  'Galatasaray SK': [
    'Galatasaray', 'GAL', 'Galata',
  ],
  'Fenerbahce SK': [
    'Fenerbahce', 'Fener', 'FEN', 'Fenerbahçe',
  ],
  'Shakhtar Donetsk': [
    'Shakhtar', 'SHA', 'FC Shakhtar', 'Shakhtar Donetsk',
  ],
  'BSC Young Boys': [
    'Young Boys', 'BSC Young Boys', 'YB',
  ],
  'Slavia Prague': [
    'Slavia Prague', 'Slavia Praha', 'Slavia', 'SLA',
  ],
  'Sparta Prague': [
    'Sparta Prague', 'Sparta Praha', 'Sparta', 'SPA',
  ],
  'Red Star Belgrade': [
    'Red Star Belgrade', 'Red Star', 'Crvena Zvezda', 'RSB',
  ],
  'FC Salzburg': [
    'Salzburg', 'RB Salzburg', 'Red Bull Salzburg', 'SAL',
  ],
  'Sturm Graz': [
    'Sturm Graz', 'Sturm', 'STU',
  ],
};

// Manchester United can face domestic or European opposition in the same
// team-scoped feed, so use the union rather than choosing a league preset.
const MAN_UNITED = { ...EFL, ...UCL };

const LEAGUE_ALIAS_DEFAULTS = {
  'epl': [
    'EPL', 'Premier League', 'PL', 'English Premier League',
    'EPL.', 'Premier.League', 'PremierLeague',
    'BPL', // Barclays PL — occasional
  ],
  'championship': [
    'Championship', 'EFL Championship', 'Sky Bet Championship',
    'Championship.', 'EFL',
  ],
  'league-one': [
    'League One', 'EFL League One', 'League 1', 'L1',
    'League.One', 'LeagueOne', 'EFL',
  ],
  'efl': [
    'EFL', 'EPL', 'Premier League', 'PL', 'Championship',
    'League One', 'L1', 'FA Cup', 'EFL Cup', 'Carabao Cup',
  ],
  'nfl': [
    'NFL', 'National Football League', 'NFL Pre Season', 'NFL Preseason',
    'Pre Season', 'Preseason',
  ],
  'nba': [
    'NBA', 'National Basketball Association',
  ],
  'mlb': [
    'MLB', 'Major League Baseball',
  ],
  'ucl': [
    'UCL', 'CL', 'Champions League', 'Champions.League',
    'UEFA Champions League', 'UEFA CL', 'UEFA',
  ],
};


// -----------------------------------------------------------------
// The American big three — NFL, NBA, MLB.
//
// Added after measuring the problem rather than assuming it. The reported
// symptom was "very hit and miss"; the open question was whether the indexers
// simply had nothing. They do have it. Searching the live Prowlarr/Usenet
// stack for one fixture returned, among others:
//
//   NFL.Pre.Season.2026.08.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p...
//   NFL.2021.10.28.Cardinals.Vs.Packers.1080p.WEB.h264-SPORTSNET
//   NFL.2021.10.28.Packers.at.Cardinals.720p.HDTV...-720pier
//
// The first matched. The other two were rejected with `no-home-team`, because
// the matcher only ever knew the full "City Nickname" that ESPN and the MLB
// schedule hand us, and two of the most prolific groups name their releases
// by nickname alone. Nothing was wrong with coverage; SSS could not recognise
// what it was being shown.
//
// Alias policy here differs from the football tables above in one way: a US
// nickname is the team's PRIMARY release-name form, not a fan nickname, so it
// belongs in search queries as well as in relevance matching. Where a bare
// city or nickname is ambiguous WITHIN its own league it is left out on
// purpose -- "Chicago" is both Cubs and White Sox, "New York" is both Mets and
// Yankees -- while the same word is safe in a league where only one team
// carries it.
// -----------------------------------------------------------------

const NFL = {
  'Arizona Cardinals': [
    'Cardinals', 'Arizona', 'ARI', 'AZ Cardinals',
  ],
  'Atlanta Falcons': [
    'Falcons', 'Atlanta', 'ATL',
  ],
  'Baltimore Ravens': [
    'Ravens', 'Baltimore', 'BAL',
  ],
  'Buffalo Bills': [
    'Bills', 'Buffalo', 'BUF',
  ],
  'Carolina Panthers': [
    'Panthers', 'Carolina', 'CAR',
  ],
  'Chicago Bears': [
    'Bears', 'Chicago', 'CHI',
  ],
  'Cincinnati Bengals': [
    'Bengals', 'Cincinnati', 'CIN',
  ],
  'Cleveland Browns': [
    'Browns', 'Cleveland', 'CLE',
  ],
  'Dallas Cowboys': [
    'Cowboys', 'Dallas', 'DAL',
  ],
  'Denver Broncos': [
    'Broncos', 'Denver', 'DEN',
  ],
  'Detroit Lions': [
    'Lions', 'Detroit', 'DET',
  ],
  'Green Bay Packers': [
    'Packers', 'Green Bay', 'GB', 'GNB',
  ],
  'Houston Texans': [
    'Texans', 'Houston', 'HOU',
  ],
  'Indianapolis Colts': [
    'Colts', 'Indianapolis', 'IND',
  ],
  'Jacksonville Jaguars': [
    'Jaguars', 'Jacksonville', 'JAX', 'Jags',
  ],
  'Kansas City Chiefs': [
    'Chiefs', 'Kansas City', 'KC', 'KAN',
  ],
  'Las Vegas Raiders': [
    'Raiders', 'Las Vegas', 'LV', 'LVR', 'Oakland Raiders',
  ],
  'Los Angeles Chargers': [
    'Chargers', 'LA Chargers', 'LAC', 'San Diego Chargers',
  ],
  'Los Angeles Rams': [
    'Rams', 'LA Rams', 'LAR', 'St Louis Rams',
  ],
  'Miami Dolphins': [
    'Dolphins', 'Miami', 'MIA',
  ],
  'Minnesota Vikings': [
    'Vikings', 'Minnesota', 'MIN',
  ],
  'New England Patriots': [
    'Patriots', 'New England', 'NE', 'NWE', 'Pats',
  ],
  'New Orleans Saints': [
    'Saints', 'New Orleans', 'NO', 'NOR',
  ],
  'New York Giants': [
    'Giants', 'NY Giants', 'NYG',
  ],
  'New York Jets': [
    'Jets', 'NY Jets', 'NYJ',
  ],
  'Philadelphia Eagles': [
    'Eagles', 'Philadelphia', 'PHI', 'Philly',
  ],
  'Pittsburgh Steelers': [
    'Steelers', 'Pittsburgh', 'PIT',
  ],
  'San Francisco 49ers': [
    '49ers', 'San Francisco', 'SF', 'SFO', 'Niners',
  ],
  'Seattle Seahawks': [
    'Seahawks', 'Seattle', 'SEA',
  ],
  'Tampa Bay Buccaneers': [
    'Buccaneers', 'Tampa Bay', 'TB', 'TAM', 'Bucs',
  ],
  'Tennessee Titans': [
    'Titans', 'Tennessee', 'TEN',
  ],
  'Washington Commanders': [
    'Commanders', 'Washington', 'WAS', 'WSH',
  ],
};

const NBA = {
  'Atlanta Hawks': [
    'Hawks', 'Atlanta', 'ATL',
  ],
  'Boston Celtics': [
    'Celtics', 'Boston', 'BOS',
  ],
  'Brooklyn Nets': [
    'Nets', 'Brooklyn', 'BKN', 'BRK',
  ],
  'Charlotte Hornets': [
    'Hornets', 'Charlotte', 'CHA', 'CHO',
  ],
  'Chicago Bulls': [
    'Bulls', 'Chicago', 'CHI',
  ],
  'Cleveland Cavaliers': [
    'Cavaliers', 'Cleveland', 'CLE', 'Cavs',
  ],
  'Dallas Mavericks': [
    'Mavericks', 'Dallas', 'DAL', 'Mavs',
  ],
  'Denver Nuggets': [
    'Nuggets', 'Denver', 'DEN',
  ],
  'Detroit Pistons': [
    'Pistons', 'Detroit', 'DET',
  ],
  'Golden State Warriors': [
    'Warriors', 'Golden State', 'GS', 'GSW',
  ],
  'Houston Rockets': [
    'Rockets', 'Houston', 'HOU',
  ],
  'Indiana Pacers': [
    'Pacers', 'Indiana', 'IND',
  ],
  'Los Angeles Clippers': [
    'Clippers', 'LA Clippers', 'LAC',
  ],
  'Los Angeles Lakers': [
    'Lakers', 'LA Lakers', 'LAL',
  ],
  'Memphis Grizzlies': [
    'Grizzlies', 'Memphis', 'MEM',
  ],
  'Miami Heat': [
    'Heat', 'Miami', 'MIA',
  ],
  'Milwaukee Bucks': [
    'Bucks', 'Milwaukee', 'MIL',
  ],
  'Minnesota Timberwolves': [
    'Timberwolves', 'Minnesota', 'MIN', 'Wolves',
  ],
  'New Orleans Pelicans': [
    'Pelicans', 'New Orleans', 'NO', 'NOP',
  ],
  'New York Knicks': [
    'Knicks', 'NY Knicks', 'NYK',
  ],
  'Oklahoma City Thunder': [
    'Thunder', 'Oklahoma City', 'OKC',
  ],
  'Orlando Magic': [
    'Magic', 'Orlando', 'ORL',
  ],
  'Philadelphia 76ers': [
    '76ers', 'Philadelphia', 'PHI', 'Sixers',
  ],
  'Phoenix Suns': [
    'Suns', 'Phoenix', 'PHX', 'PHO',
  ],
  'Portland Trail Blazers': [
    'Trail Blazers', 'Portland', 'POR', 'Blazers',
  ],
  'Sacramento Kings': [
    'Kings', 'Sacramento', 'SAC',
  ],
  'San Antonio Spurs': [
    'Spurs', 'San Antonio', 'SA', 'SAS',
  ],
  'Toronto Raptors': [
    'Raptors', 'Toronto', 'TOR',
  ],
  'Utah Jazz': [
    'Jazz', 'Utah', 'UTA',
  ],
  'Washington Wizards': [
    'Wizards', 'Washington', 'WAS', 'WSH',
  ],
};

const MLB = {
  'Arizona Diamondbacks': [
    'Diamondbacks', 'Arizona', 'ARI', 'D-backs', 'Dbacks',
  ],
  'Atlanta Braves': [
    'Braves', 'Atlanta', 'ATL',
  ],
  'Baltimore Orioles': [
    'Orioles', 'Baltimore', 'BAL',
  ],
  'Boston Red Sox': [
    'Red Sox', 'Boston', 'BOS',
  ],
  'Chicago Cubs': [
    'Cubs', 'CHC',
  ],
  'Chicago White Sox': [
    'White Sox', 'CWS', 'CHW',
  ],
  'Cincinnati Reds': [
    'Reds', 'Cincinnati', 'CIN',
  ],
  'Cleveland Guardians': [
    'Guardians', 'Cleveland', 'CLE',
  ],
  'Colorado Rockies': [
    'Rockies', 'Colorado', 'COL',
  ],
  'Detroit Tigers': [
    'Tigers', 'Detroit', 'DET',
  ],
  'Houston Astros': [
    'Astros', 'Houston', 'HOU',
  ],
  'Kansas City Royals': [
    'Royals', 'Kansas City', 'KC', 'KCR',
  ],
  'Los Angeles Angels': [
    'Angels', 'LA Angels', 'LAA', 'Anaheim Angels',
  ],
  'Los Angeles Dodgers': [
    'Dodgers', 'LA Dodgers', 'LAD',
  ],
  'Miami Marlins': [
    'Marlins', 'Miami', 'MIA',
  ],
  'Milwaukee Brewers': [
    'Brewers', 'Milwaukee', 'MIL',
  ],
  'Minnesota Twins': [
    'Twins', 'Minnesota', 'MIN',
  ],
  'New York Mets': [
    'Mets', 'NY Mets', 'NYM',
  ],
  'New York Yankees': [
    'Yankees', 'NY Yankees', 'NYY',
  ],
  'Athletics': [
    'Oakland Athletics', 'Athletics', 'OAK', 'ATH', 'Sacramento Athletics',
  ],
  'Philadelphia Phillies': [
    'Phillies', 'Philadelphia', 'PHI',
  ],
  'Pittsburgh Pirates': [
    'Pirates', 'Pittsburgh', 'PIT',
  ],
  'San Diego Padres': [
    'Padres', 'San Diego', 'SD', 'SDP',
  ],
  'San Francisco Giants': [
    'Giants', 'SF Giants', 'San Francisco', 'SF', 'SFG',
  ],
  'Seattle Mariners': [
    'Mariners', 'Seattle', 'SEA',
  ],
  'St. Louis Cardinals': [
    'St Louis Cardinals', 'St. Louis', 'St Louis', 'STL',
  ],
  'Tampa Bay Rays': [
    'Rays', 'Tampa Bay', 'TB', 'TBR',
  ],
  'Texas Rangers': [
    'Rangers', 'Texas', 'TEX',
  ],
  'Toronto Blue Jays': [
    'Blue Jays', 'Toronto', 'TOR',
  ],
  'Washington Nationals': [
    'Nationals', 'Washington', 'WSH', 'WSN', 'Nats',
  ],
};


const PRESETS = {
  epl: EPL,
  nfl: NFL,
  nba: NBA,
  mlb: MLB,
  championship: CHAMPIONSHIP,
  'league-one': LEAGUE_ONE,
  efl: EFL,
  ucl: UCL,
  'man-united': MAN_UNITED,
};

function getPreset(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  const alias = {
    'premier-league': 'epl', 'premier_league': 'epl', 'premierleague': 'epl',
    'champions-league': 'ucl', 'champions_league': 'ucl', 'championsleague': 'ucl',
    'uefa': 'ucl',
    'league1': 'league-one', 'league_one': 'league-one', 'leagueone': 'league-one', 'l1': 'league-one',
    'englishfootball': 'efl', 'english-football': 'efl', 'all-english': 'efl',
  }[key] || key;
  return PRESETS[alias] || null;
}

function getLeagueAliasDefaults(name) {
  if (!name) return [];
  const key = String(name).toLowerCase().trim();
  const alias = {
    'premier-league': 'epl', 'premier_league': 'epl', 'premierleague': 'epl',
    'champions-league': 'ucl', 'champions_league': 'ucl', 'championsleague': 'ucl',
    'uefa': 'ucl',
    'league1': 'league-one', 'league_one': 'league-one', 'leagueone': 'league-one', 'l1': 'league-one',
  }[key] || key;
  return (LEAGUE_ALIAS_DEFAULTS[alias] || []).slice();
}

function listPresetNames() {
  return ['epl', 'championship', 'league-one', 'efl', 'ucl', 'man-united',
    'nfl', 'nba', 'mlb'];
}

module.exports = { getPreset, getLeagueAliasDefaults, listPresetNames };
