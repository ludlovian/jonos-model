
----------------------------------------------------------------
--
-- The FTS search tables

drop table if exists searchAlbum;
create virtual table if not exists searchMedia
  using fts5(id, text);


drop view if exists searchAlbumEx;
drop view if exists searchMediaEx;
create view if not exists searchMediaEx as
  select  a.id,
          a.text,
          b.metadata
    from  searchMedia a
    join  mediaMetadata b on b.id = a.id;


----------------------------------------------------------------
--
-- Rebuild sproc
--

drop view if exists rebuildSearch;
create view if not exists rebuildSearch (unused) as select 0  where 0;

create trigger if not exists rebuildSearch_sproc instead of insert on rebuildSearch
begin

  delete from searchMedia;
  insert into searchMedia (id, text)
    select  b.id,
            concat_ws(' ',
              a.title,
              a.artist,
              a.genre
            )
    from  album a
    join  track b on (b.album, b.seq) = (a.id, 0)
    union all
    select  a.id,
            concat_ws(' ', 'radio', a.title)
      from  radio a
    union all
    select  a.id,
            'tv'
      from  media a
      join  mediaType b on b.id = a.type
      where b.name = 'tv';

end;

