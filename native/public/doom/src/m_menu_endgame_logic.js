// Pure routing rule from m_menu.c:M_EndGame.

export function M_EndGameRoute(usergame, netgame) {
  if (usergame !== true) return 'inactive';
  if (netgame === true) return 'netgame';
  return 'confirm';
}
