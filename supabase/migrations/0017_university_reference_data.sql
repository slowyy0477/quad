-- ---------------------------------------------------------------------------
-- 0017_university_reference_data.sql
--
-- A starting list of real universities, so the onboarding form has something to
-- offer on a fresh deployment.
--
-- This is reference data, not seed data. Every row names a real institution that
-- exists independently of this application; none of it is invented, and none of it
-- represents a person. That distinction is the reason this is allowed to ship to
-- production while a list of example students would not be.
--
-- The list is deliberately incomplete and says so in the UI. `universities` has a
-- user-submission path (insert policy `universities_insert_authenticated` files a
-- row as `pending`; a moderator approves it), which is the mechanism for
-- everything not listed here. Hard-coding a "complete" list would be the fake
-- version of that feature.
--
-- Two decisions worth stating:
--
--   * `email_domains` is left empty for every row even where the domain is
--     obvious. That column drives automatic university affiliation, so a wrong
--     entry silently affiliates strangers with an institution they have nothing to
--     do with. An empty array means "no automatic verification", which is the
--     correct answer until someone verifies each domain deliberately.
--
--   * The before-insert trigger is disabled for the duration. It exists to force
--     client submissions to `status = 'pending'` and to overwrite `submitted_by`,
--     which is right for a client and wrong for reference data -- and its slug
--     generator would derive slugs from names, where an explicit slug is a stable
--     URL that can be reviewed in this diff. Re-enabled in the same transaction,
--     so a failure anywhere leaves the trigger on.
--
-- Idempotent on `slug`: re-running changes nothing. Editing a name here will not
-- update an existing row -- write a new migration for that, the same as any other
-- data change.
-- ---------------------------------------------------------------------------

alter table public.universities disable trigger universities_before_insert;

insert into public.universities (slug, name, short_name, country, city, website, status)
values
  -- Pakistan
  ('nust',        'National University of Sciences and Technology', 'NUST',     'Pakistan', 'Islamabad',  'https://nust.edu.pk',      'approved'),
  ('lums',        'Lahore University of Management Sciences',       'LUMS',     'Pakistan', 'Lahore',     'https://lums.edu.pk',      'approved'),
  ('fast-nu',     'National University of Computer and Emerging Sciences', 'FAST-NU', 'Pakistan', 'Islamabad', 'https://nu.edu.pk',  'approved'),
  ('comsats',     'COMSATS University Islamabad',                  'COMSATS',  'Pakistan', 'Islamabad',  'https://comsats.edu.pk',   'approved'),
  ('uet-lahore',  'University of Engineering and Technology Lahore', 'UET Lahore', 'Pakistan', 'Lahore',  'https://uet.edu.pk',      'approved'),
  ('punjab',      'University of the Punjab',                       'PU',       'Pakistan', 'Lahore',     'https://pu.edu.pk',        'approved'),
  ('aku',         'Aga Khan University',                            'AKU',      'Pakistan', 'Karachi',    'https://aku.edu',          'approved'),
  ('iba-karachi', 'Institute of Business Administration Karachi',   'IBA',      'Pakistan', 'Karachi',    'https://iba.edu.pk',       'approved'),
  ('giki',        'Ghulam Ishaq Khan Institute of Engineering Sciences and Technology', 'GIKI', 'Pakistan', 'Topi', 'https://giki.edu.pk', 'approved'),
  ('ned-uet',     'NED University of Engineering and Technology',   'NED UET',  'Pakistan', 'Karachi',    'https://neduet.edu.pk',    'approved'),
  ('qau',         'Quaid-i-Azam University',                        'QAU',      'Pakistan', 'Islamabad',  'https://qau.edu.pk',       'approved'),
  ('karachi',     'University of Karachi',                          'KU',       'Pakistan', 'Karachi',    'https://uok.edu.pk',       'approved'),
  ('air',         'Air University',                                 'AU',       'Pakistan', 'Islamabad',  'https://au.edu.pk',        'approved'),
  ('bahria',      'Bahria University',                              'BU',       'Pakistan', 'Islamabad',  'https://bahria.edu.pk',    'approved'),
  ('ucp',         'University of Central Punjab',                   'UCP',      'Pakistan', 'Lahore',     'https://ucp.edu.pk',       'approved'),
  ('itu',         'Information Technology University',              'ITU',      'Pakistan', 'Lahore',     'https://itu.edu.pk',       'approved'),

  -- India
  ('iit-bombay',  'Indian Institute of Technology Bombay',          'IIT Bombay', 'India',   'Mumbai',     'https://iitb.ac.in',       'approved'),
  ('iit-delhi',   'Indian Institute of Technology Delhi',           'IIT Delhi',  'India',   'New Delhi',  'https://iitd.ac.in',       'approved'),
  ('iisc',        'Indian Institute of Science',                    'IISc',       'India',   'Bengaluru',  'https://iisc.ac.in',       'approved'),

  -- United Kingdom
  ('oxford',      'University of Oxford',                           'Oxford',   'United Kingdom', 'Oxford',     'https://ox.ac.uk',         'approved'),
  ('cambridge',   'University of Cambridge',                        'Cambridge','United Kingdom', 'Cambridge',  'https://cam.ac.uk',        'approved'),
  ('imperial',    'Imperial College London',                        'Imperial', 'United Kingdom', 'London',     'https://imperial.ac.uk',   'approved'),
  ('ucl',         'University College London',                      'UCL',      'United Kingdom', 'London',     'https://ucl.ac.uk',        'approved'),
  ('edinburgh',   'University of Edinburgh',                        'Edinburgh','United Kingdom', 'Edinburgh',  'https://ed.ac.uk',         'approved'),
  ('manchester',  'University of Manchester',                       'Manchester','United Kingdom','Manchester', 'https://manchester.ac.uk', 'approved'),

  -- United States
  ('mit',         'Massachusetts Institute of Technology',          'MIT',      'United States', 'Cambridge, MA', 'https://mit.edu',       'approved'),
  ('stanford',    'Stanford University',                            'Stanford', 'United States', 'Stanford, CA',  'https://stanford.edu',  'approved'),
  ('harvard',     'Harvard University',                             'Harvard',  'United States', 'Cambridge, MA', 'https://harvard.edu',   'approved'),
  ('berkeley',    'University of California, Berkeley',             'Berkeley', 'United States', 'Berkeley, CA',  'https://berkeley.edu',  'approved'),
  ('cmu',         'Carnegie Mellon University',                     'CMU',      'United States', 'Pittsburgh, PA','https://cmu.edu',       'approved'),
  ('georgia-tech','Georgia Institute of Technology',                'Georgia Tech','United States','Atlanta, GA', 'https://gatech.edu',    'approved'),

  -- Canada
  ('toronto',     'University of Toronto',                          'U of T',   'Canada', 'Toronto',   'https://utoronto.ca',      'approved'),
  ('waterloo',    'University of Waterloo',                         'Waterloo', 'Canada', 'Waterloo',  'https://uwaterloo.ca',     'approved'),
  ('ubc',         'University of British Columbia',                 'UBC',      'Canada', 'Vancouver', 'https://ubc.ca',           'approved'),
  ('mcgill',      'McGill University',                              'McGill',   'Canada', 'Montreal',  'https://mcgill.ca',        'approved'),

  -- Australia
  ('melbourne',   'University of Melbourne',                        'Melbourne','Australia', 'Melbourne', 'https://unimelb.edu.au', 'approved'),
  ('sydney',      'University of Sydney',                           'Sydney',   'Australia', 'Sydney',    'https://sydney.edu.au',  'approved'),
  ('unsw',        'University of New South Wales',                  'UNSW',     'Australia', 'Sydney',    'https://unsw.edu.au',    'approved'),

  -- Europe
  ('eth-zurich',  'ETH Zurich',                                     'ETH',      'Switzerland', 'Zurich',  'https://ethz.ch',          'approved'),
  ('tu-delft',    'Delft University of Technology',                 'TU Delft', 'Netherlands', 'Delft',   'https://tudelft.nl',       'approved'),
  ('tu-munich',   'Technical University of Munich',                 'TUM',      'Germany',     'Munich',  'https://tum.de',           'approved'),
  ('kth',         'KTH Royal Institute of Technology',              'KTH',      'Sweden',      'Stockholm','https://kth.se',          'approved'),

  -- Asia
  ('nus',         'National University of Singapore',               'NUS',      'Singapore', 'Singapore', 'https://nus.edu.sg',      'approved'),
  ('ntu-singapore','Nanyang Technological University',              'NTU',      'Singapore', 'Singapore', 'https://ntu.edu.sg',      'approved'),
  ('tsinghua',    'Tsinghua University',                            'Tsinghua', 'China',     'Beijing',   'https://tsinghua.edu.cn', 'approved'),
  ('peking',      'Peking University',                              'PKU',      'China',     'Beijing',   'https://pku.edu.cn',      'approved'),
  ('tokyo',       'University of Tokyo',                            'UTokyo',   'Japan',     'Tokyo',     'https://u-tokyo.ac.jp',   'approved'),
  ('kaist',       'Korea Advanced Institute of Science and Technology', 'KAIST', 'South Korea','Daejeon',  'https://kaist.ac.kr',     'approved'),
  ('hkust',       'Hong Kong University of Science and Technology',  'HKUST',    'Hong Kong', 'Hong Kong', 'https://hkust.edu.hk',    'approved'),

  -- Middle East and Africa
  ('kaust',       'King Abdullah University of Science and Technology', 'KAUST', 'Saudi Arabia', 'Thuwal',   'https://kaust.edu.sa', 'approved'),
  ('khalifa',     'Khalifa University',                             'Khalifa',  'United Arab Emirates', 'Abu Dhabi', 'https://ku.ac.ae', 'approved'),
  ('cape-town',   'University of Cape Town',                        'UCT',      'South Africa', 'Cape Town', 'https://uct.ac.za',    'approved'),
  ('cairo',       'Cairo University',                               'Cairo',    'Egypt',        'Giza',      'https://cu.edu.eg',    'approved')

on conflict (slug) do nothing;

alter table public.universities enable trigger universities_before_insert;
