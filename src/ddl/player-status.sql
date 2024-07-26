----------------------------------------------------------------
--
-- volatile details  of each player
--

create table if not exists playerStatus (
  id          integer primary key,
  leader      integer,
  volume      integer,
  mute        integer,
  playState   text,
  playMode    text,
  media       integer,  -- media id of current item
  foreign key (id) references player (id),
  foreign key (leader) references player (id),
  foreign key (media) references media(id)
);

----------------------------------------------------------------
--

drop view if exists playerEx;
create view if not exists playerEx as
  select  a.id,
          a.name,
          a.fullName,
          c.name as leaderName,
          b.id = b.leader as isLeader,
          b.volume,
          b.mute,
          b.playState in  ('PLAYING', 'TRANSITIONING') as playing,
          b.playMode in ('REPEAT', 'REPEAT_ALL') as repeat,
          d.sonosUrl,
          e.metadata,
          f.items
    from  player a
    join  playerStatus b on b.id = a.id
    join  player c on c.id = b.leader
    join  media d on d.id = b.media
    join  mediaMetadata e on e.id = d.id
    join  queueEx f on f.player = a.id;

----------------------------------------------------------------
