----------------------------------------------------------------
create view if not exists mediaMetadata as
  with cteTracks as (
    select  a.id,
            json_object(
              'id', a.id,
              'url', c.sonosUrl,
              'type', d.name,
              'albumId', b.id,
              'albumArtist', b.artist,
              'album', b.title,
              'genre', b.genre,
              'title', a.title,
              'seq', a.seq
            ) as metadata
      from  track a
      join  album b on b.id = a.album
      join  media c on c.id = a.id
      join  mediaType d on d.id = c.type
  ),
  cteRadio as (
    select  a.id,
            json_object(
              'id', a.id,
              'url', b.sonosUrl,
              'type', c.name,
              'title', a.title,
              'nowPlaying', a.nowPlaying
            ) as metadata
      from  radio a
      join  media b on b.id = a.id
      join  mediaType c on c.id = b.type
  ),
  cteOther as (
    select  a.id,
            json_object(
              'id', a.id,
              'url', a.sonosUrl,
              'type', b.name
            ) as metadata
      from  media a
      join  mediaType b on b.id = a.type
      where a.id not in (select id from track)
        and a.id not in (select id from radio)
  )
  select  id, metadata from cteTracks
  union all
  select  id, metadata from cteRadio
  union all
  select  id, metadata from cteOther;


