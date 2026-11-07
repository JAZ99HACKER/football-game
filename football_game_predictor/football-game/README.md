# Football Prediction Game

Predict scores and bet game tokens (no real money) on the Premier League, La Liga, Bundesliga and Champions League. The World Cup appears automatically when its fixtures are within about 2 months.

Players choose a nickname (no password) and everything is saved in their own browser. Scores come from football-data.org through a scheduled GitHub Actions job, so your API key stays secret.

## Setup (about 15 minutes)

### 1. Create the repository
1. On github.com click **New repository**. Name it e.g. `football-game`. Choose **Public** (free GitHub Pages needs a public repo; your API key stays secret anyway).
2. Click **uploading an existing file** and drag in everything from this folder (unzip it first). Commit.
3. Check that `.github/workflows/update-data.yml` arrived. Hidden folders are often skipped when dragging. If it is missing: **Add file → Create new file**, type `.github/workflows/update-data.yml` as the name, and paste the contents of `setup/update-data.yml`.

### 2. Add your API key as a secret
1. Repository **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `FOOTBALL_DATA_TOKEN`. Value: your football-data.org token. Save.

### 3. Allow the job to save data
**Settings → Actions → General → Workflow permissions →** choose **Read and write permissions**. Save.

### 4. Run the first update
**Actions** tab → **Update football data** → **Run workflow**. It takes about 1.5 minutes. When it finishes, `data/data.json` is filled with fixtures and tables. After that it repeats every 30 minutes by itself.

### 5. Turn on the website
**Settings → Pages →** Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**. Save. After a minute your game is live at `https://YOUR-USERNAME.github.io/football-game/`. Share that link with friends.

## If something looks wrong
- **"Waiting for the first score update"**: step 4 has not run yet or failed. Open the failed run in the Actions tab and read the red step.
- **Run fails with HTTP 403 or 401**: the token is wrong or not set as `FOOTBALL_DATA_TOKEN`.
- **Updates stop after a long quiet period**: GitHub can pause scheduled jobs on quiet repos. Open the Actions tab and re-enable the workflow.
- **A league is missing**: its fetch failed. The last good data is kept, and the run log shows a WARNING for that league.

## Rules (all in `js/scoring.js`)
- Start with 100 tokens. If you fall below 5 you get a free top-up to 25, at most once a week.
- Match bet: stake 5, 10, 15, 20 or 25. Total goal error = goals off, summed over both teams.
  - Exact score pays 2x (3x in high-stakes matches), 1 goal off 1.5x, 2 off 0.5x, 3 or more loses the stake.
  - If you get the win/draw/loss wrong, the multiplier is capped at 0.5x.
  - Bets can be changed or cancelled until kickoff.
- High-stakes matches: listed derbies and rivalries, top-6 clashes in domestic leagues, Champions League/World Cup knockouts and finals.
- Cup knockouts settle on the score after extra time (penalty shootout goals excluded).
- Season winner: one locked pick per league. Multiplier is fixed when you place it: 1.5x for the leader up to 15x for ranks 7 and lower, reduced by up to 50% as the season goes on (never below 1.1x). Picks close once 80% of the matches are played. Tokens stay staked until the season ends.

## Development
```
node --test tests/game.test.js tests/smoke.test.js
python3 -m unittest discover -s tests -p "test_*.py"
```
To edit rules or rivalries, change `js/scoring.js` (the `RULES` and `RIVALRIES` blocks) and run the tests.
