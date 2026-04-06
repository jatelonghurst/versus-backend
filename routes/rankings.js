import express from 'express';
import pool from '../lib/db.js';
import { newRatings } from '../lib/elo.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /rankings/me — get the current user's full ranked list
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.spotify_track_id, s.title, s.artist, s.album,
              s.album_art_url, us.elo_score, us.wins, us.losses, us.comparisons
       FROM user_songs us
       JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1
       ORDER BY us.elo_score DESC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /rankings/pair — get two random songs to compare
router.get('/pair', requireAuth, async (req, res) => {
  try {
    // Prioritize songs with fewer comparisons for faster convergence
    const { rows } = await pool.query(
      `SELECT s.id, s.spotify_track_id, s.title, s.artist,
              s.album_art_url, us.elo_score, us.comparisons
       FROM user_songs us
       JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1
       ORDER BY us.comparisons ASC, RANDOM()
       LIMIT 10`,
      [req.user.userId]
    );

    if (rows.length < 2) {
      return res.status(400).json({ error: 'Not enough songs' });
    }

    // Pick two different songs from the candidates
    const shuffled = rows.sort(() => Math.random() - 0.5);
    res.json({ songA: shuffled[0], songB: shuffled[1] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /rankings/compare — record a comparison result
router.post('/compare', requireAuth, async (req, res) => {
  const { winnerId, loserId } = req.body;
  if (!winnerId || !loserId) return res.status(400).json({ error: 'Missing song ids' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current ELO scores
    const { rows: songs } = await client.query(
      `SELECT us.song_id, us.elo_score, us.wins, us.losses, us.comparisons
       FROM user_songs us
       WHERE us.user_id = $1 AND us.song_id = ANY($2)`,
      [req.user.userId, [winnerId, loserId]]
    );

    const winner = songs.find(s => s.song_id === winnerId);
    const loser = songs.find(s => s.song_id === loserId);

    if (!winner || !loser) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Songs not found in your library' });
    }

    const { winner: newWinnerElo, loser: newLoserElo } = newRatings(
      winner.elo_score,
      loser.elo_score
    );

    // Update winner
    await client.query(
      `UPDATE user_songs SET elo_score=$1, wins=wins+1, comparisons=comparisons+1, updated_at=now()
       WHERE user_id=$2 AND song_id=$3`,
      [newWinnerElo, req.user.userId, winnerId]
    );

    // Update loser
    await client.query(
      `UPDATE user_songs SET elo_score=$1, losses=losses+1, comparisons=comparisons+1, updated_at=now()
       WHERE user_id=$2 AND song_id=$3`,
      [newLoserElo, req.user.userId, loserId]
    );

    // Record the comparison
    await client.query(
      `INSERT INTO comparisons (user_id, winner_song_id, loser_song_id)
       VALUES ($1, $2, $3)`,
      [req.user.userId, winnerId, loserId]
    );

    await client.query('COMMIT');
    res.json({ winnerElo: newWinnerElo, loserElo: newLoserElo });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /rankings/u/:username — public profile rankings (top 10)
router.get('/u/:username', async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT id, display_name, avatar_url FROM users WHERE username = $1`,
      [req.params.username]
    );
    if (!users.length) return res.status(404).json({ error: 'User not found' });

    const user = users[0];
    const { rows: top10 } = await pool.query(
      `SELECT s.title, s.artist, s.album_art_url, us.elo_score
       FROM user_songs us
       JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1 AND us.comparisons > 0
       ORDER BY us.elo_score DESC
       LIMIT 10`,
      [user.id]
    );

    res.json({ user, rankings: top10 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
