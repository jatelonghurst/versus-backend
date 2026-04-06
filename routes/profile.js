import express from 'express';
import pool from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /profile/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, spotify_id, username, display_name, avatar_url, created_at FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /profile/stats — how many songs, comparisons made
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(DISTINCT us.song_id) as total_songs,
         SUM(us.comparisons) / 2 as total_comparisons
       FROM user_songs us
       WHERE us.user_id = $1`,
      [req.user.userId]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /profile/compare/:username — taste overlap with another user
router.get('/compare/:username', requireAuth, async (req, res) => {
  try {
    const { rows: target } = await pool.query(
      `SELECT id, display_name, avatar_url FROM users WHERE username = $1`,
      [req.params.username]
    );
    if (!target.length) return res.status(404).json({ error: 'User not found' });

    // Find songs both users have in common (top 10 each)
    const { rows: myTop } = await pool.query(
      `SELECT song_id FROM user_songs WHERE user_id = $1 ORDER BY elo_score DESC LIMIT 10`,
      [req.user.userId]
    );
    const { rows: theirTop } = await pool.query(
      `SELECT song_id FROM user_songs WHERE user_id = $1 ORDER BY elo_score DESC LIMIT 10`,
      [target[0].id]
    );

    const myIds = new Set(myTop.map(r => r.song_id));
    const theirIds = new Set(theirTop.map(r => r.song_id));
    const overlap = [...myIds].filter(id => theirIds.has(id));

    const compatibilityScore = Math.round((overlap.length / 10) * 100);

    // Get shared song details
    let sharedSongs = [];
    if (overlap.length > 0) {
      const { rows } = await pool.query(
        `SELECT title, artist, album_art_url FROM songs WHERE id = ANY($1)`,
        [overlap]
      );
      sharedSongs = rows;
    }

    res.json({
      user: target[0],
      compatibilityScore,
      sharedSongs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
