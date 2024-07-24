----------------------------------------------------------------
--
-- Notify settings

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
