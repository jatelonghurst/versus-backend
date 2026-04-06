import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import pool from '../lib/db.js';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = 'user-top-read user-read-private user-read-email';

// Step 1: Redirect user to Spotify login
router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
  });
  res.redirect(`${SPOTIFY_AUTH_URL}?${params}`);
});

// Step 2: Spotify redirects back with a code
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post(SPOTIFY_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token } = tokenRes.data;

    // Get user profile from Spotify
    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const spotifyUser = profileRes.data;

    // Upsert user in our database
    const { rows } = await pool.query(
      `INSERT INTO users (spotify_id, username, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (spotify_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [
        spotifyUser.id,
        spotifyUser.id, // use spotify id as username initially
        spotifyUser.display_name,
        spotifyUser.images?.[0]?.url || null,
      ]
    );

    const user = rows[0];

    // Fetch top tracks from Spotify and store them
    await syncTopTracks(user.id, access_token);

    // Issue our own JWT
    const token = jwt.sign(
      { userId: user.id, spotifyId: user.spotify_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Redirect to frontend with token
    res.redirect(`${process.env.FRONTEND_URL}/auth?token=${token}`);
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// Fetch and store user's top 50 tracks from Spotify
async function syncTopTracks(userId, accessToken) {
  const res = await axios.get('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const tracks = res.data.items;

  for (const track of tracks) {
    // Upsert song
    const { rows } = await pool.query(
      `INSERT INTO songs (spotify_track_id, title, artist, album, album_art_url, preview_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (spotify_track_id) DO UPDATE
         SET title = EXCLUDED.title, artist = EXCLUDED.artist
       RETURNING id`,
      [
        track.id,
        track.name,
        track.artists.map(a => a.name).join(', '),
        track.album.name,
        track.album.images?.[0]?.url || null,
        track.preview_url || null,
      ]
    );

    const songId = rows[0].id;

    // Add to user's library if not already there
    await pool.query(
      `INSERT INTO user_songs (user_id, song_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, song_id) DO NOTHING`,
      [userId, songId]
    );
  }
}

export default router;
