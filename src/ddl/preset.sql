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

create view if not exists presetEx as
  select  a.name,
          a.leader,
          b.key as player,
          b.value as volume
    from  preset a
    join  json_each(a.volumes) b;

----------------------------------------------------------------
