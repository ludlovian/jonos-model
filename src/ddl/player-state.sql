----------------------------------------------------------------
--
drop view if exists playerState;
create view if not exists playerState as
  with isLeader as (
    select  id, id = leader as isLeader
      from  playerStatus
  )
  select  a.id,
          a.name,
          jsonb_object(
            'id', a.id,
            'name', a.name,
            'fullName', a.fullName,
            'leaderName', a.leaderName,
            'volume', a.volume,
            'mute', json(iif(a.mute, 'true', 'false')),
            'playing', iif(b.isLeader, jsonb(iif(a.playing, 'true', 'false')), null),
            'repeat', iif(b.isLeader, jsonb(iif(a.repeat, 'true', 'false')), null),
            'current', iif(b.isLeader, jsonb(a.metadata), null),
            'queue', iif(b.isLeader, jsonb(a.items), null)
          ) as state
    from  playerEx a
    join  isLeader b on b.id = a.id;


----------------------------------------------------------------


