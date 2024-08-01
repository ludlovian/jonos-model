export default `
----------------------------------------------------------------
-- The runtime (temp) elements for the main Jonos database

----------------------------------------------------------------
--
--  Pragma settings for the main connection
pragma journal_mode = wal;
pragma foreign_keys = true;
pragma recursive_triggers = true;
pragma trusted_schema = false;
pragma synchronous = normal;

begin;

----------------------------------------------------------------
--
--  Triggers to record changes to the system status
--  

create trigger temp.systemStatus_upd
  after update on systemStatus
begin
  insert into playerChange(player, key, value, timestamp)
    select  null, new.item, new.value, julianday()
      where new.value is not old.value;
end;

----------------------------------------------------------------
--
--  Triggers on player to calculate derived values
--
--  NOTE: This trigger refers to 'mediaEx' which is in the
--        library database, which must be attached by the time
--        this runs.

create trigger temp.player_upd_derived after update of
  leaderId, playState, playMode, mediaId, queueIds
on player
begin
  update  player
    set   isLeader = (new.id = new.leaderId),
          leaderName = (select name from player where id=new.leaderId)
    where id = new.id
      and new.leaderId is not old.leaderId;

  update  player
    set   playing =
      case when new.id = new.leaderId
        then new.playState in ('PLAYING', 'TRANSITIONING')
        else null
      end
    where id = new.id
      and (new.playState is not old.playState
        or new.leaderId is not old.leaderId);

  update  player
    set   repeats =
      case when new.id = new.leaderId
        then new.playMode in ('REPEAT', 'REPEAT_ALL')
        else null
      end
    where id = new.id
      and (new.playMode is not old.playMode
        or new.leaderId is not old.leaderId);

  --
  -- in the casde of mediaId changing, we also
  -- update the played timestamp on the media table
  -- itself

  update  player
    set   media =
      case when new.id = new.leaderId
        then (select metadata from mediaEx where id=new.mediaId)
        else null
      end
    where id = new.id
      and (new.mediaId is not old.mediaId
        or new.leaderId is not old.leaderId);

  update  media
    set   played = julianday()
    where id = new.mediaId
      and (new.mediaId is not old.mediaId
        or new.leaderId is not old.leaderId);

  update  player
    set   queue =
      case when new.id = new.leaderId
            and new.queueIds is not null
        then (select  json_group_array(json(b.metadata)) as queue
                from  json_each(new.queueIds) a
                join  mediaEx b on b.id = a.value)
        else null
      end
    where id = new.id
      and (new.queueIds is not old.queueIds
        or new.leaderId is not old.leaderId);
end;

----------------------------------------------------------------
--
-- Trigger to record changes in state
--

create trigger if not exists temp.player_update_change after update of
  leaderName, volume, mute, playing, media, queue, nowStream
on player
begin
  insert into playerChange(player, timestamp, key, value)
    select  new.id, julianday(), * from (
        select  'leaderName', new.leaderName
          where new.leaderName is not old.leaderName
        union all
        select  'volume', new.volume
          where new.volume is not old.volume
        union all
        select  'mute', new.mute
          where new.mute is not old.mute
        union all
        select  'playing', new.playing
          where new.playing is not old.playing
        union all
        select  'media', new.media
          where new.media is not old.media
        union all
        select  'queue', new.queue
          where new.queue is not old.queue
        union all
        select  'nowStream', new.nowStream
          where new.nowStream is not old.nowStream
      );
end;

----------------------------------------------------------------
--
-- Main updatePlayer stored proc
--
--  Mandatory parms:
--      - id
--
--  Optional parms:
--      - leaderUuid
--      - volume
--      - mute
--      - playMode
--      - playState
--      - url (of current media)
--      - metadata (JSON object)
--      - queue (JSON array of urls)
--
--  NOTE: This stored proc uses 'ensureMedia', 'media' and 'mediaEx'
--        which are in the library runtimeDDL.
--        So the library database must be ATTACHed before this is run.
--

create view temp.updatePlayer
  (id, volume, mute, playMode, playState, leaderUuid, url, metadata, queue)
  as select 0,0,0,0,0,0,0,0,0 where 0;
create trigger temp.updatePlayer_sproc instead of insert on updatePlayer
begin
  -- make sure the media row exists if given
  insert into ensureMedia(url)
    select new.url where new.url is not null;

  -- similarly for the array of URLs if given
  insert into ensureMedia(url)
    select  value from json_each(new.queue)
      where new.queue is not null;

  -- Now update each element of the player separately
  -- It might take a few more CPU cycles, but it makes it much
  -- easier to understand and maintain

  update  player
    set   leaderId = (select id from player where uuid = new.leaderUuid)
    where id = new.id
      and new.leaderUuid is not null;

  update  player
    set   volume = new.volume
    where id = new.id
      and new.volume is not null;

  update  player
    set   mute = new.mute
    where id = new.id
      and new.mute is not null;

  update  player
    set   playState = new.playState
    where id = new.id
      and new.playState is not null;

  update  player
    set   playMode = new.playMode
    where id = new.id
      and new.playMode is not null;

  update  player
    set   mediaId = (select id from media where url = new.url)
    where id = new.id
      and new.url is not null;

  -- nowStream is a little more tricky
  -- we extract it from the json object, but only
  -- if we are playing a radio, and it isnt ZPSTR_*

  update  player
    set   nowStream = val.nowStream

    from  (
      select  new.metadata ->> '$.streamContent' as nowStream
        from  player a
        join  mediaEx b on b.id = a.mediaId
          and a.id = new.id
          and b.type = 'radio' 
          and new.metadata is not null
    ) as val

    where id = new.id
      and val.nowStream not glob 'ZPSTR_*'
      and player.nowStream is not val.nowStream;

  -- queueIds are converted from urls to ids
  -- we use a special sentinel of '' to set the queueIds to null
  -- as nulls mean 'do not update this'

  update  player
    set   queueIds = (
      select  json_group_array(b.id) as queue
        from  json_each(new.queue) a
        join  media b on b.url = a.value
        where new.queue is not null
          and new.queue != ''
        order by a.key
    )

    where id = new.id
      and new.queue is not null
      and new.queue != '';

  update  player
    set   queueIds = null
    where new.queue = '';

end;

----------------------------------------------------------------
--
--  updatePlayerTopology
--
--  Updates all the leaders of the players in one go, adding
--  new players as required
--

create view temp.updatePlayerTopology (players) as select 0 where 0;
create trigger temp.updatePlayerTopology_sproc
  instead of insert on updatePlayerTopology
begin

  insert or ignore into player (uuid, fullName, url)
    select  value ->> '$.uuid',
            value ->> '$.fullName',
            value ->> '$.url'
      from  json_each(new.players);

  delete from player
    where uuid not in (
      select value ->> '$.uuid'
        from  json_each(new.players)
    );

  insert into updatePlayer(id, leaderUuid)
    select  b.id,
            a.value ->> '$.leaderUuid'
    from    json_each(new.players) a
    join    player b on b.uuid = a.value ->> '$.uuid';

end;

----------------------------------------------------------------
--
--  playerActionsNeeded
--
--  A view which idenitifies additional actions needed based on
--  the current status
--
--  NOTE: this view uses 'mediaEx' from the library database
--        So this must be ATTACHed before accessing this view
--

create view temp.playerActionsNeeded as
  --
  -- We might need to refresh the queue if a player
  --    - is a leader
  --    - has a track as the current media
  --    - and EITHER has no queue OR
  --                 the current media does not appear in the queue
  --
  with needsQueues (id, name, cmd) as (
    select  a.id, a.name, 'getQueue'
      from  player a
      join  mediaEx b on b.id = a.mediaId
      where a.isLeader is true
        and b.type = 'track'
        and (
          a.queueIds is null
          or
          a.mediaId not in (select value from json_each(a.queueIds))
        )
  ),
  --
  --  We might need to update the track uri if a player
  --    - is a leader
  --    - has no media at all (not even the '' url denoting
  --      no media loaded)
  needsAvTransport (id, name, cmd) as (
    select  a.id, a.name, 'updateAvTransport'
      from  player a
      where a.isLeader is true
        and a.mediaId is null
  ),
  --
  --  If a player has started following another (media type='follow')
  --  the we need to update the leader if we still think they are
  --  a leader. It will happen eventually at the next topology updated
  --  but we can pre-empt this
  needsLeader (id, name, cmd) as (
    select  a.id, a.name, 'updateLeader'
      from  player a
      join  mediaEx b on b.id = a.mediaId
      where a.isLeader is true
        and b.type = 'follow'
  )

  select  * from needsQueues
  union all
  select  * from needsAvTransport
  union all
  select  * from needsLeader;


----------------------------------------------------------------
commit;


-- vim: ft=sql ts=2 sts=2 sw=2 et
----------------------------------------------------------------
`
