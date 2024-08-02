export default `

savepoint library_runtime_ddl;
----------------------------------------------------------------
--
-- Runtime (temp) DDL for the library
--

----------------------------------------------------------------
--
--  ensureMedia
--
--  This is a frequently called stored proc to ensure that
--  a url actually exists in the media table, adding one
--  if needed.

--  Oddly this seems to work with a CTE in it, even though the
--  documtation says that CTEs are not supported inside triggers.
--
--  It wouldn't be difficult to rewriet the CTE as a FROM clause
--  but it is cleaner this way.

create view temp.ensureMedia (url) as select 0  where 0;
create trigger temp.ensureMedia_sproc instead of insert on ensureMedia
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

end;

----------------------------------------------------------------
--
--  Stored procedures to create media metadata from an album
--
--  For sanity sake, we use a temp table to store the
--  track <-> media link initially as we also need seq and
--  url.
--
--  The contents only exists for the duration of the stored proc
--

create table temp.tmpAlbumTracks (id, seq unique, url unique);
create index temp.tmpAlbumTracks_ix_1 on tmpAlbumTracks (id);

----------------------------------------------------------------
--
--  deleteAlbumFromMedia
--
--    path    - the path where the album can be found
--
create view temp.deleteAlbum (path) as select 0 where 0;
create trigger temp.deleteAlbum_sproc instead of insert on deleteAlbum
begin
  delete from tmpAlbumTracks;
  insert into tmpAlbumTracks (id, url)
    select  a.id,
            c.url
      from  albumTracks a
      join  album b on b.id = a.albumId
      join  media c on c.id = a.id
      where b.path = new.path;

  delete from mediaMetadata
    where id in (select id from tmpAlbumTracks);
  delete from albumTracks
    where id in (select id from tmpAlbumTracks);
  delete from media
    where id in (select id from tmpAlbumTracks);
  delete from album
    where path = new.path;

  delete from tmpAlbumTracks;
end;

----------------------------------------------------------------
--
--  addAlbum
--
--    path      - the path where the album can be found
--    hash      - the hash of the file
--    prefix    - the cifs prefix
--    metadata  - the JSON metadata
--    artwork   - (optional) the artwork id
--

create view temp.addAlbum (path, hash, prefix, metadata, artwork)
  as select 0, 0, 0, 0, 0 where 0;
create trigger temp.addAlbum_sproc instead of insert on addAlbum
begin

  -- ensure any trace of the album has been removed
  insert into deleteAlbum (path) values (new.path);

  -- add the album record
  insert into album (path, hash, metadata)
    values (new.path, new.hash, jsonb(new.metadata));

  -- construct the urls and save them into the temp table
  delete from tmpAlbumTracks;
  insert into tmpAlbumTracks (url, seq)
    select  concat(new.prefix, new.path, '/', a.value ->> '$.file'),
            a.key
      from  json_each(new.metadata, '$.tracks') a;

  -- add the urls into media
  -- this will also create entries in mediaMetadata
  insert into media (url, type, artwork)
    select  a.url,
            b.id,
            new.artwork
      from  tmpAlbumTracks a
      join  mediaType b on b.name = 'track'
      order by a.seq;

  -- update the tmp table with the new ids
  update  tmpAlbumTracks
    set   id = val.id
    from  (
      select  b.id,
              a.url
      from    tmpAlbumTracks a
      join    media b on b.url = a.url
    ) as val
    where tmpAlbumTracks.url = val.url;

  -- now save that tmp table into the proper linking table
  insert into albumTracks (id, albumId, seq)
    select  a.id,
            b.id as albumId,
            a.seq
      from  tmpAlbumTracks a
      join  album b on b.path = new.path;

  -- update the metadata table with the metadata
  update  mediaMetadata
    set   metadata = val.metadata
    from  (
      select  a.id,
              json_object(
                'id', a.id,
                'type', 'track',
                'albumId', b.id,
                'seq', a.seq,
                'url', a.url,
                'albumArtist', b.metadata ->> '$.albumArtist',
                'album', b.metadata ->> '$.album',
                'title', c.value ->> '$.title'
              ) as metadata
        from  tmpAlbumTracks a
        join  album b on b.path = new.path
        join  json_each(b.metadata, '$.tracks') c on c.key = a.seq
    ) as val
    where mediaMetadata.id = val.id;

  -- PHEW!
  delete from tmpAlbumTracks;
end;

----------------------------------------------------------------
--
--  rebuildSearch
--
--  a storedProc to rebuild the FTS search table

create temp view rebuildSearch (unused) as select 0  where 0;
create temp trigger rebuildSearch_sproc instead of insert on rebuildSearch
begin

  delete from searchMedia;

  insert into searchMedia (id, text)
    select  a.id,
            concat_ws(' ',
              b.metadata ->> '$.albumArtist',
              b.metadata ->> '$.album',
              b.metadata ->> '$.genre'
            )
    from  albumTracks a
    join  album b on b.id = a.albumId
    where a.seq = 0
    union all
    select  id,
            concat_ws(' ', type, title)
      from  mediaEx
      where type in ('tv','radio');

end;

----------------------------------------------------------------
release savepoint library_runtime_ddl;


-- vim: ft=sql ts=2 sts=2 sw=2 et
----------------------------------------------------------------
`
