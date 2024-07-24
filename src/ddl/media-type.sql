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
