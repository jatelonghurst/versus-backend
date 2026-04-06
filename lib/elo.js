const K = 32; // How much each match affects the score

export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export function newRatings(winnerRating, loserRating) {
  const expectedWinner = expectedScore(winnerRating, loserRating);
  const expectedLoser = expectedScore(loserRating, winnerRating);

  return {
    winner: Math.round(winnerRating + K * (1 - expectedWinner)),
    loser: Math.round(loserRating + K * (0 - expectedLoser)),
  };
}
