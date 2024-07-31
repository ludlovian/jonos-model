export default `
----------------------------------------------------------------
-- holds the schema number
--
--
create table if not exists schema (
  id        integer primary key not null check (id = 1),
  version   integer not null
);
insert or ignore into schema values(1, 2);

----------------------------------------------------------------
--
-- settings table, with a single row

create table if not exists settings (
  id                integer primary key not null check (id = 1),
  cifsPrefix        text not null,
  libraryRoot       text not null
);

insert or ignore into settings
  values (
    1,
    'x-file-cifs://pi2.local/data/',
    'library/files'
  );

----------------------------------------------------------------
--
-- Presets

create table if not exists preset (
  id          integer primary key,
  name        text not null unique,
  title       text,
  leader      text not null,
  volumes     text not null
);

insert or ignore into preset (name, title, leader, volumes)
values
  ( 'standard', 'Standard', 'bookroom', json_object(
      'bookroom', 25,
      'bedroom', 25,
      'parlour', 25,
      'kitchen', 25,
      'archive', 18,
      'study', 12,
      'diningroom', 12
  )),
  ( 'zoom', 'Zoom', 'bookroom', json_object(
      'bookroom', 25,
      'bedroom', 25,
      'kitchen', 25,
      'archive', 18,
      'diningroom', 12
  )),
  ( 'guests', 'Guests', 'bookroom', json_object(
      'bookroom', 15,
      'bedroom', 50,
      'parlour', 12,
      'kitchen', 50,
      'archive', 50,
      'study', 10,
      'diningroom', 10
  ));
----------------------------------------------------------------

drop view if exists presetEx;
create view if not exists presetEx as
  select  a.name,
          a.leader,
          b.key as player,
          b.value as volume
    from  preset a
    join  json_each(a.volumes) b;

----------------------------------------------------------------
--
-- Notifies table

create table if not exists notify (
  id          integer primary key not null,
  name        text not null unique,
  title       text,
  leader      text,
  url         text,
  volume      integer,
  resume      integer
);

insert or ignore into notify (name, title, leader, url, volume, resume )
values
(
  'downstairs', 'Downstairs', 'bookroom',
  'https://media-readersludlow.s3-eu-west-1.amazonaws.com/public/come-downstairs.mp3',
  50, false
),
(
  'feed_us', 'Feed Us', 'bookroom',
  'https://media-readersludlow.s3.eu-west-1.amazonaws.com/public/feed-us-now.mp3',
  50, true
),
(
  'test', 'Test', 'study',
  'https://media-readersludlow.s3.eu-west-1.amazonaws.com/public/feed-me-now.mp3',
  15, true
);

----------------------------------------------------------------
-- System status table

create table if not exists systemStatus (
  id        integer primary key not null check (id = 1),
  started       float,
  version       text,
  listeners     integer default 0,
  listening     integer default 0,
  jonosRefresh  integer default 0
);
insert or ignore into systemStatus (id) values (1);
drop trigger if exists systemStatus_upd_listeners;
create trigger if not exists systemStatus_upd_listeners
  after update of listeners, listening, jonosRefresh
  on systemStatus
begin
  insert into playerChange(player, key, value, timestamp)
    select  null, a.key, a.curr, julianday()
      from  (
        select  'listeners' as key,
                old.listeners as prev,
                new.listeners as curr
        union all
        select  'listening' as key,
                old.listening as prev,
                new.listening as curr
        union all
        select  'jonosRefresh' as key,
                old.jonosRefresh as prev,
                new.jonosRefresh as curr
      ) a
      where a.curr is not a.prev;
end;


drop view if exists systemStatusEx;
create view if not exists systemStatusEx as
  with
  chgMinMax as (
    select  min(id) as firstChange,
            max(id) as lastChange
      from  playerChange
  )
  select  strftime('%FT%TZ', a.started) as started,
          a.version,
          ifnull(a.listeners, 0) as listeners,
          a.listening,
          a.jonosRefresh,
          b.firstChange,
          b.lastChange
    from  systemStatus a
    join  chgMinMax b;

drop table if exists dataVersion;

----------------------------------------------------------------
-- artwork
--

create table if not exists artwork (
  id            integer primary key,
  file          text,
  hash          text,
  image         blob,
  unique (file)
);


----------------------------------------------------------------
create table if not exists mediaType (
  id            integer primary key,
  name          text,
  prefix        text,
  artwork       integer,      -- default art for the type
  unique (name),
  unique (prefix),
  foreign key (artwork) references artwork (id)
);

insert or ignore into mediaType(id, name, prefix)
  values  (1, 'queue',  'x-rincon-queue:'),
          (2, 'follow', 'x-rincon:'),
          (3, 'radio',  'x-rincon-mp3radio:'),
          (4, 'tv',     'x-sonos-htastream:'),
          (5, 'track',  'x-file-cifs:'),
          (6, 'web',    'https:'),
          (7, 'sonos',  'x-rincon'),
          (9, 'other',  '');

----------------------------------------------------------------
--
-- media items that can be played
--
-- Each is given an unique id
--

create table if not exists media (
  id            integer primary key,
  type          integer not null,
  url           text not null,
  title         text,
  artwork       integer,
  metadata      blob,     -- JSONB of metadata
  played        real,
  unique (url),
  foreign key (artwork) references artwork (id)
);

create index if not exists media_ix_1 on media (type);

----------------------------------------------------------------
-- Trigger to update metadata
--
drop trigger if exists media_metadata_upd;
create trigger if not exists media_metadata_upd
  after update of metadata on media when new.metadata is null
begin
  update  media
    set   metadata = val.metadata
    from  (
      select  json_object(
                'id', id,
                'type', 'track',
                'albumId', albumId,
                'seq', seq,
                'url', url,
                'albumArtist', albumArtist,
                'album', album,
                'title', title
              ) as metadata
        from  trackEx
        where id = new.id
    union all
      select  json_object(
                'id', id,
                'type', type,
                'url', url,
                'title', title
              )
        from  mediaEx
        where id = new.id
          and type != 'track'
    ) as val
    where id = new.id
      and val.metadata is not null;
end;


drop view if exists ensureMedia;
create view ensureMedia (url) as select 0  where 0;
create trigger ensureMedia_sproc instead of insert on ensureMedia
begin
  insert or ignore into media (type, url, artwork)
    with cteType as (
      select  id as typeId, artwork
        from  mediaType
        where new.url glob prefix || '*'
        order by id
        limit 1
    )
    select  typeId, new.url, artwork
      from  cteType;

  -- add in the best guess of metadata if not set
  update  media
    set   metadata = null
    where url = new.url
      and metadata is null;
end;

----------------------------------------------------------------
--
drop view if exists mediaEx;
create view if not exists mediaEx as
  select  a.id,
          b.name as type,
          a.url,
          a.title,
          a.metadata,
          a.artwork,
          datetime(played, 'localtime') as played
    from  media a
    join  mediaType b on b.id = a.type;

----------------------------------------------------------------
-- albums
--
-- which dynamically build tracks from metadata
--
-- trackEx is logically simply a view, but we materialize it with
-- triggers to improve performance

create table if not exists album (
  id            integer primary key,
  path          text,       -- relative to jonos
  hash          text,       -- hash of the metadata file
  metadata      blob,       -- JSONB of metadata
  title         text generated always as
                  (metadata ->> '$.album') stored,
  artist        text generated always as
                  (metadata ->> '$.albumArtist') stored,
  genre         text generated always as
                  (metadata ->> '$.genre') stored,
  cover         text generated always as
                  (ifnull(metadata ->> '$.cover','cover.jpg')) stored,
  unique (path)
);

drop trigger if exists album_ins;
create trigger if not exists album_ins after insert on album
begin
  update  album
    set   metadata = jsonb(metadata)
    where id = new.id;
end;

drop trigger if exists album_upd;
create trigger if not exists album_upd after update of metadata on album
begin

  -- get rid of old tracks

  delete from track
    where albumId = new.id;

  -- now ensure that the urls are registered on media
  insert into ensureMedia
    select  concat(b.cifsPrefix, new.path, '/', a.value ->> '$.file')
      from  json_each(new.metadata, '$.tracks') a
      join  settings b;

  -- and insert them into the track table
  insert into track
    (id, albumId, seq, url, title, file, artist)
    select  c.id                      as id,
            new.id                    as albumId, 
            a.key                     as seq,
            concat(b.cifsPrefix, new.path, '/', a.value ->> '$.file')
                                      as url,
            a.value ->> '$.title'     as title,
            a.value ->> '$.file'      as file,
            a.value -> '$.artist'     as artist
      from  json_each(new.metadata, '$.tracks') a
      join  settings b
      join  media c on c.url =
            concat(b.cifsPrefix, new.path, '/', a.value ->> '$.file');

  -- finally we update the metadata on the media table
  update  media
    set   metadata = null
    where id in (select id from track where albumId = new.id);

end;

----------------------------------------------------------------

create table if not exists track (
  id          integer primary key not null,
  albumId     integer not null,
  seq         integer not null,
  url         integer not null,
  title       text,
  file        text,
  artist      text,

  foreign key (id) references media (id)
  unique (url)
);

----------------------------------------------------------------
drop view if exists trackEx;
create view if not exists trackEx as
  select  a.id,
          a.albumId,
          a.seq,
          a.url,
          b.artist as albumArtist,
          b.title as album,
          a.title,
          b.genre,
          a.artist
    from  track a
    join  album b on b.id = a.albumId;

----------------------------------------------------------------

create virtual table if not exists searchMedia
  using fts5(id, text);

drop view if exists rebuildSearch;
create view if not exists rebuildSearch (unused) as select 0  where 0;
create trigger if not exists rebuildSearch_sproc instead of insert on rebuildSearch
begin
  delete from searchMedia;
  insert into searchMedia (id, text)
    select  id,
            concat_ws(' ',
              albumArtist,
              album,
              genre
            )
    from  trackEx
    where seq = 0
    union all
    select  id,
            concat_ws(' ', type, title)
      from  mediaEx
      where type in ('tv','radio');
end;

drop view if exists searchMediaEx;
create view if not exists searchMediaEx as
  select  a.id,
          a.text,
          b.metadata
    from  searchMedia a
    join  media b on b.id = a.id;

----------------------------------------------------------------
create table if not exists player (
  -- static attributes
  id          integer primary key,
  uuid        text not null,
  fullName    text not null,
  url         text not null,
  model       text,
  name        text generated always as
                (lower(replace(fullName, ' ', ''))) stored,

  -- dynamic attributes
  leader      integer,
  volume      integer,
  mute        integer,
  playState   text,
  playMode    text,
  media       integer,    -- id of the media for this url
  queue       text,       -- JSON array of media ids
  nowStream   text,

  -- generated attributes
  isLeader    integer generated always as
                (id = leader),
  playing     integer generated always as
                (playState in ('PLAYING','TRANSITIONING')),
  repeats     integer generated always as
                (playMode in ('REPEAT','REPEAT_ALL')),

  unique (uuid),
  unique (url),
  unique (name),
  foreign key (leader) references player(id),
  foreign key (media) references media(id)
);

----------------------------------------------------------------
-- player changes

create table if not exists playerChange (
  id          integer primary key not null,
  player      integer,
  key         text,
  value       any,
  timestamp   real,
  foreign key (player) references player(id)
);
drop trigger if exists player_update_change;
create trigger if not exists player_update_change after update of
  leader, volume, mute, playState, playMode, media, queue, nowStream
on player
begin
  insert into playerChange(player, key, value, timestamp)
    select  new.id, key, value, julianday()
      from  (
        select  'leaderName'          as key,
                leaderName            as value
          from  playerEx
          where id = new.id
            and new.leader is not old.leader
      union all
        select  'volume'              as key,
                new.volume            as value
          where new.volume is not old.volume
      union all
        select  'mute'                as key,
                new.mute              as value
          where new.mute is not old.mute
      union all
        select  'playing'             as key,
                playing               as value
          from  playerEx
          where id = new.id
            and new.playState is not old.playState
      union all
        select  'media'               as key,
                media                 as value
          from  playerEx
          where id = new.id
            and new.media is not old.media
      union all
        select  'queue'               as key,
                queue                 as value
          from  playerEx
          where id = new.id
            and new.queue is not old.queue
      union all
        select  'nowStream'           as key,
                new.nowStream         as value
          where new.nowStream is not old.nowStream
      );
end;

drop view if exists playerChangeEx;
create view playerChangeEx as
  select  a.id,
          ifnull(b.name, 'system') as player,
          a.key,
          a.value,
          datetime(a.timestamp, 'localtime', 'subsecond') as timestamp
    from  playerChange a
    left join player b on b.id = a.player;

----------------------------------------------------------------
-- playerEx view

drop view if exists playerEx;
create view if not exists playerEx as
  with cteQueue as (
    select  a.id,
            json_group_array(json(c.metadata)) as queue
      from  player a
      join  json_each(a.queue) b
      join  media c on c.id = b.value
      group by a.id
  )
  select  a.id,
          a.name,
          a.uuid,
          a.fullName,
          a.url,
          a.model,
          a.leader,
          b.name as leaderName,
          a.isLeader,
          a.volume,
          a.mute,
          iif(a.isLeader, a.playState, null) as playState,
          iif(a.isLeader, a.playing, null) as playing,
          iif(a.isLeader, a.playMode, null) as playMode,
          iif(a.isLeader, a.repeats, null) as repeats,
          d.metadata as media,
          c.queue as queue,
          iif(a.isLeader, a.nowStream, null) as nowStream

    from  player a
    join  player b on b.id = a.leader
    left join cteQueue c on c.id = a.id
    left join media d on d.id = a.media;




----------------------------------------------------------------
--
-- Main updatePlayer stored proc
--

drop view if exists updatePlayer;
create view updatePlayer
  (id, volume, mute, playMode, playState, leaderUuid, url, metadata)
  as select 0,0,0,0,0,0,0,0 where 0;
create trigger updatePlayer_sproc instead of insert on updatePlayer
begin
  -- make sure the media row exists if given
  insert into ensureMedia(url)
    select new.url where new.url is not null;

  -- The player record is updated in stages. First
  -- is the leader (from leaderUuid) if given as this
  -- will affect later updates

  update  player
    set   leader = val.leader
    from  (
      select  ifnull(b.id, a.leader) as leader
        from  player a
        join  player b on b.uuid = new.leaderUuid
        where a.id = new.id
    ) as val
    where id = new.id
      and player.leader is not val.leader;

  -- Then we set the volume/mute/playState & playMode
  update  player
    set (volume, mute, playState, playMode) =
          (val.volume, val.mute, val.playState, val.playMode)
    from (
      select  ifnull(new.volume, a.volume) as volume,
              ifnull(new.mute, a.mute) as mute,
              ifnull(new.playState, a.playState) as playState,
              ifnull(new.playMode, a.playMode) as playMode
        from  player a
        where a.id = new.id
    ) as val
    where id = new.id
      and (player.volume, player.mute, player.playState, player.playMode)
      is not (val.volume, val.mute, val.playState, val.playMode);

  -- The we update the current media from the url if given
  update  player
    set   media = val.media
    from  (
      select  iif(
                a.isLeader,
                ifnull(b.id, a.media),
                null
              ) as media
        from  player a
        left join  media b on b.url = new.url
        where a.id = new.id
    ) as val
    where id = new.id
      and player.media is not val.media;

  -- Update the nowStream from the metadata if we are playing a radio
  update  player
    set   nowStream = val.nowStream
    from  ( select  new.metadata ->> '$.streamContent' as nowStream
              from  player a
              join  mediaEx b on b.id = a.media
              where a.id = new.id
                and b.type = 'radio'
                and new.metadata is not null
          ) as val
    where id = new.id
      and player.nowStream is not val.nowStream;

  -- We set the queue to null if we are not a leader
  update  player
    set   queue = null
    where id = new.id
      and not isLeader
      and queue is not null;

  -- We also et the queue to null if:
  --  - if we are a leader, but playing something other than
  --    a track
  --
  update  player
    set   queue = null
    from  ( select  1
              from  player a
              join  mediaEx b on b.id = a.media
              where a.id = new.id
                and b.type != 'track'
          ) as val
    where id = new.id
      and isLeader
      and new.url is not null
      and queue is not null;

  -- We request a 'getQueue' action if
  --  - a url was given
  --  - this is a leader
  --  - playing a track
  --  - the queue is null OR
  --      the current media item is not on the queue

  insert into command (player, cmd)
    select  new.id, 'getQueue'
      from  player a
      join  mediaEx b on b.id = a.media
      where a.id = new.id
        and new.url is not null
        and a.isLeader
        and b.type = 'track'
        and ( a.queue is null
          or  a.media not in
                (select value from json_each(a.queue))
        );

  -- If we claim to be playing but have no media, then
  -- we are out of sync.So we ask for a refresh
  --
  -- This can sometimes happen when a player changes media
  -- by alarm

  insert into command (player, cmd)
    select  new.id, 'updateEverything'
      from  player a
      where a.id = new.id
        and a.media is null
        and a.playing = true
        and a.isLeader = true;

end;

----------------------------------------------------------------
--
-- updatePlayerTopology
--
-- Updates all the leaders of the players in one go, adding
-- new players as required
--


drop view if exists updatePlayerTopology;
create view updatePlayerTopology (players) as select 0 where 0;
create trigger updatePlayerTopology_sproc instead of insert on updatePlayerTopology
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
--  updatePlayerQueue
--
--  converts a player Queue of urls into a media ids
--

drop view if exists updatePlayerQueue;
create view if not exists updatePlayerQueue (id, urls) as select 0,0 where 0;
create trigger if not exists updatePlayerQueue_sproc instead of insert on updatePlayerQueue
begin
  -- make sure each url has a media id

  insert into ensureMedia (url)
  select value from json_each(new.urls);

  -- set the queue if it is an array of urls

  update  player
    set   queue = val.queue
    from  (
      select  json_group_array(b.id) as queue
        from  json_each(new.urls) a
        join  media b on b.url = a.value
        where new.urls is not null
        order by a.key
    ) as val
    where id = new.id
      and new.urls is not null
      and player.queue is not val.queue;

  -- set the queue if it is nulls

  update  player
    set   queue = null
    where id = new.id
      and new.urls is null
      and queue is not null;

end;


----------------------------------------------------------------
--
-- The command table for queueing commands to a player
--
--

create table if not exists command (
  id          integer primary key not null,
  player      integer not null,
  cmd         text not null,
  parms       text,
  foreign key (player) references player (id)
);

drop view if exists commandEx;
create view if not exists commandEx as
  select  a.id,
          b.name as player,
          a.cmd,
          a.parms
    from  command a
    join  player b on b.id = a.player;

drop view if exists addCommand;
create view if not exists addCommand(player, cmd, parms)
  as select 0,0,0 where 0;
create trigger if not exists addCommand_sproc
  instead of insert on addCommand
begin
  insert into command(player, cmd, parms)
    select  a.id as player,
            new.cmd,
            new.parms
      from  player a
      where (typeof(new.player) = 'text' and a.name = new.player)
        or  (typeof(new.player) = 'integer' and a.id = new.player);
end;

----------------------------------------------------------------
--
--  The complete current state for the sytem in a vertical
--  table with
--      - player / 'system'
--      - key
--      - value
--
drop view if exists currentState;
create view if not exists currentState as
  with lastChange (id) as
  (
    select ifnull(max(id),0) as id from playerChange
  ),
  playerKeys (key) as (
    values
      ('id'),('name'),('uuid'),('fullName'),('url'),('model'),
      ('leaderName'),('volume'),('mute'),('playing'),('media'),('queue'),
      ('nowStream')
  ),
  playerState (id, player, key, value) as 
  (
    select  c.id,
            a.name,
            b.key,
            case b.key
              when 'id'           then a.id
              when 'name'         then a.name
              when 'uuid'         then a.uuid
              when 'fullName'     then a.fullName
              when 'url'          then a.url
              when 'model'        then a.model
              when 'leaderName'   then a.leaderName
              when 'volume'       then a.volume
              when 'mute'         then a.mute
              when 'playing'      then a.playing
              when 'media'        then a.media
              when 'queue'        then a.queue
              when 'nowStream'    then a.nowStream
            end as value
      from  playerEx a
      join  playerKeys b
      join  lastChange c
  ),
  systemKeys (key) as (
    values  ('started'),('version'),('listeners'),('listening'),
            ('jonosRefresh')
  ),
  systemState (id, player, key, value) as (
    select  c.id,
            'system',
            b.key,
            case b.key
              when 'started'      then a.started
              when 'version'      then a.version
              when 'listeners'    then a.listeners
              when 'listening'    then a.listening
              when 'jonosRefresh' then a.jonosRefresh
            end as value
      from  systemStatusEx a
      join  systemKeys b
      join  lastChange c
  ),
  presetState (id, player, key, value) as (
    select  b.id,
            'system',
            'presets',
            json_group_object(a.name, a.title) as value
    from    preset a
    join    lastChange b
    group by 1,2,3
  ),
  notifyState (id, player, key, value) as (
    select  b.id,
            'system',
            'notifies',
            json_group_object(a.name, a.title) as value
      from  notify a
      join  lastChange b
      group by 1,2,3
  )
  select * from systemState
  union all
  select * from presetState
  union all
  select * from notifyState
  union all
  select * from playerState
  order by 1;

----------------------------------------------------------------

-- vim: ft=sql ts=2 sts=2 sw=2 et
----------------------------------------------------------------
`
