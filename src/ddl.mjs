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
-- settings table, with a row for each setting

create table if not exists settings (
  id                integer primary key,
  item              text not null,
  value             any,
  unique (item)
);

insert or ignore into settings (item, value)
values
  ('cifsPrefix',      'x-file-cifs://pi2.local/data/'),
  ('libraryRoot',     'library/files');

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
--
-- A key/value table for various attributes about the current system
--

create table if not exists systemStatus (
  id        integer primary key not null,
  item      text not null,
  value     any,
  unique(item)
);
insert or ignore into systemStatus (item)
values
  ('started'),
  ('version'),
  ('listeners'),
  ('listening'),
  ('jonosRefresh');

drop trigger if exists systemStatus_upd;
create trigger if not exists systemStatus_upd
  after update on systemStatus
begin
  insert into playerChange(player, key, value, timestamp)
    select  null, new.item, new.value, julianday()
      where new.value is not old.value;
end;


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
    select  concat(b.value, new.path, '/', a.value ->> '$.file')
      from  json_each(new.metadata, '$.tracks') a
      join  settings b on b.item = 'cifsPrefix';

  -- and insert them into the track table
  insert into track
    (id, albumId, seq, url, title, file, artist)
    select  c.id                      as id,
            new.id                    as albumId, 
            a.key                     as seq,
            concat(b.value, new.path, '/', a.value ->> '$.file')
                                      as url,
            a.value ->> '$.title'     as title,
            a.value ->> '$.file'      as file,
            a.value -> '$.artist'     as artist
      from  json_each(new.metadata, '$.tracks') a
      join  settings b on b.item = 'cifsPrefix'
      join  media c on c.url =
            concat(b.value, new.path, '/', a.value ->> '$.file');

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
--
-- The Player
--
-- This is the heart of the DB
--
-- Some columns are derived via trigger and denormalised onto the
-- row, which makes the update and change tracking process much easier

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
  leaderId    integer,
  volume      integer,
  mute        integer,
  playState   text,
  playMode    text,
  mediaId     integer,    -- id of the media for this url
  queueIds    text,       -- JSON array of media ids
  nowStream   text,

  -- derived (denormalised) attributes
  isLeader    integer,    -- leaderId derived
  playing     integer,    -- playState derived
  repeats     integer,    -- playMode derived
  leaderName  text,       -- leaderId expanded
  media       text,       -- mediaId expanded to metadata
  queue       text,       -- queueIds expanded to be an array of metadatas

  unique (uuid),
  unique (url),
  unique (name),
  foreign key (leaderId) references player(id),
  foreign key (mediaId) references media(id)
);

----------------------------------------------------------------
--
-- Triggers to calculate derived values
--

drop trigger if exists player_upd_derived;
create trigger if not exists player_upd_derived after update of
  leaderId, playState, playMode, mediaId, queueIds
on player
begin
  update  player
    set   isLeader = (new.id = new.leaderId),
          leaderName = (select name from player where id=new.leaderId)
    where id = new.id
      and new.leaderId is not old.leaderId;

  update  player
    set   playing = case when new.id = new.leaderId
                      then new.playState in ('PLAYING', 'TRANSITIONING')
                      else null
                    end
    where id = new.id
      and (new.playState is not old.playState
        or new.leaderId is not old.leaderId);

  update  player
    set   repeats = case when new.id = new.leaderId
                      then new.playMode in ('REPEAT', 'REPEAT_ALL')
                      else null
                    end
    where id = new.id
      and (new.playMode is not old.playMode
        or new.leaderId is not old.leaderId);

  update  player
    set   media = case when new.id = new.leaderId
                    then (select metadata from media where id=new.mediaId)
                    else null
                  end
    where id = new.id
      and (new.mediaId is not old.mediaId
        or new.leaderId is not old.leaderId);

  update  player
    set   queue =
            case when new.id = new.leaderId
                  and new.queueIds is not null
              then (select  json_group_array(json(b.metadata)) as queue
                      from  json_each(new.queueIds) a
                      join  media b on b.id = a.value)
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

drop trigger if exists player_update_change;
create trigger if not exists player_update_change after update of
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
-- player changes
--
-- Records player changes in a KV list
--
-- If the player is NULL, that implies a change in system status
--

create table if not exists playerChange (
  id          integer primary key not null,
  player      integer,
  key         text,
  value       any,
  timestamp   real,
  foreign key (player) references player(id)
);

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

drop view if exists updatePlayer;
create view updatePlayer
  (id, volume, mute, playMode, playState, leaderUuid, url, metadata, queue)
  as select 0,0,0,0,0,0,0,0,0 where 0;
create trigger updatePlayer_sproc instead of insert on updatePlayer
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
--  playerActionsNeeded
--
--  A view which idenitifies additional actions needed based on
--  the current status
--

drop view if exists playerActionsNeeded;
create view if not exists playerActionsNeeded as
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
      from  player a
      join  playerKeys b
      join  lastChange c
  ),
  systemState (id, player, key, value) as (
    select  b.id,
            'system',
            a.item,
            a.value
      from  systemStatus a
      join  lastChange b
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
