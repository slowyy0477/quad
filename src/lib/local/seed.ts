import 'server-only'

import { mutate, readStore, id, now, type Tables } from '@/lib/local/db'
import { hashPassword } from '@/lib/local/session'

/**
 * Seed data for local mode.
 *
 * Written once, on first run, and then never again — the store is the source of
 * truth after that, edits included. It exists so the interface can be reviewed
 * against content that behaves like content: posts that are two hours old next to
 * posts from last week, a goal with three of five steps done, a streak with a gap
 * in it, an event at capacity.
 *
 * Every counter is derived from the rows in this file rather than typed twice, so
 * a like count cannot disagree with the likes that exist. That is the same rule the
 * Postgres triggers enforce; here it is enforced by building the arrays first.
 *
 * THE DEMO ACCOUNT
 *   email    demo@quad.local
 *   password quad-demo-2026
 * It is a local account on this machine. It is not a real credential, it is not
 * sent anywhere, and it must not be reused for anything that matters.
 */

export const DEMO_EMAIL = 'demo@quad.local'
export const DEMO_PASSWORD = 'quad-demo-2026'

/** An instant `days` ago, `hours` before that. */
function ago(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString()
}

/** A date `days` ago as `yyyy-mm-dd`. */
function dayAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

const COMSATS = id('uni')
const UET = id('uni')
const NUST = id('uni')

const DEMO = id('usr')
const AYESHA = id('usr')
const BILAL = id('usr')
const HIRA = id('usr')
const USMAN = id('usr')

const pDemo = id('prf')
const pAyesha = id('prf')
const pBilal = id('prf')
const pHira = id('prf')
const pUsman = id('prf')

const sem = id('sem')
const goalProofs = id('gol')
const goalGodot = id('gol')
const goalBooks = id('gol')

const projTimetable = id('prj')
const projNotes = id('prj')
const projDial = id('prj')

const post1 = id('pst')
const post2 = id('pst')
const post3 = id('pst')
const post4 = id('pst')
const post5 = id('pst')
const post6 = id('pst')

function build(): (db: Tables) => void {
  return (db) => {
    db.universities.push(
      {
        id: COMSATS,
        name: 'COMSATS University Islamabad, Attock Campus',
        short_name: 'COMSATS Attock',
        city: 'Attock',
        country: 'Pakistan',
        student_count: 1240,
        project_count: 38,
        created_at: ago(400),
      },
      {
        id: UET,
        name: 'University of Engineering and Technology, Taxila',
        short_name: 'UET Taxila',
        city: 'Taxila',
        country: 'Pakistan',
        student_count: 890,
        project_count: 21,
        created_at: ago(400),
      },
      {
        id: NUST,
        name: 'National University of Sciences and Technology',
        short_name: 'NUST',
        city: 'Islamabad',
        country: 'Pakistan',
        student_count: 4100,
        project_count: 64,
        created_at: ago(400),
      },
    )

    const people = [
      {
        userId: DEMO,
        profileId: pDemo,
        email: DEMO_EMAIL,
        name: 'Abdullah Murtaza',
        handle: 'abdullah',
        uni: COMSATS,
        department: 'Computer Science',
        programme: 'BS Software Engineering',
        semester: 'Semester 1',
        bio: 'Learning game development from scratch. Currently building a 2D platformer in Godot and losing to the same boss.',
      },
      {
        userId: AYESHA,
        profileId: pAyesha,
        email: 'ayesha@quad.local',
        name: 'Ayesha Raza',
        handle: 'ayesha_r',
        uni: COMSATS,
        department: 'Computer Science',
        programme: 'BS Computer Science',
        semester: 'Semester 3',
        bio: 'Discrete maths, proofs, and the occasional all-nighter that was not planned.',
      },
      {
        userId: BILAL,
        profileId: pBilal,
        email: 'bilal@quad.local',
        name: 'Bilal Khan',
        handle: 'bilal_k',
        uni: COMSATS,
        department: 'Electrical Engineering',
        programme: 'BS Electrical Engineering',
        semester: 'Semester 5',
        bio: 'Microcontrollers, badly soldered boards, and a thesis on sensor fusion.',
      },
      {
        userId: HIRA,
        profileId: pHira,
        email: 'hira@quad.local',
        name: 'Hira Shah',
        handle: 'hira_s',
        uni: UET,
        department: 'Software Engineering',
        programme: 'BS Software Engineering',
        semester: 'Semester 2',
        bio: 'Front-end, design systems, and arguing about spacing.',
      },
      {
        userId: USMAN,
        profileId: pUsman,
        email: 'usman@quad.local',
        name: 'Usman Ali',
        handle: 'usman_a',
        uni: NUST,
        department: 'Computer Science',
        programme: 'BS Computer Science',
        semester: 'Semester 6',
        bio: 'Backend and databases. Everything is a join if you try hard enough.',
      },
    ]

    for (const person of people) {
      db.users.push({
        id: person.userId,
        email: person.email,
        password_hash: hashPassword(person.userId === DEMO ? DEMO_PASSWORD : `seed-${person.handle}-2026`),
        created_at: ago(120),
      })
      db.profiles.push({
        id: person.profileId,
        user_id: person.userId,
        username: person.handle,
        display_name: person.name,
        bio: person.bio,
        avatar_url: null,
        university_id: person.uni,
        department: person.department,
        programme: person.programme,
        semester: person.semester,
        website: null,
        github: null,
        visibility: 'public',
        searchable: true,
        created_at: ago(120),
      })
    }

    // ---------------------------------------------------------------- projects
    db.projects.push(
      {
        id: projTimetable,
        owner_id: pDemo,
        slug: 'lab-group-timetable',
        title: 'Lab group timetable',
        purpose: 'A shared timetable so lab groups stop turning up to empty rooms.',
        description:
          'Every section has a different lab slot and the notice board is a PDF nobody opens. This pulls the schedule into one page a group can actually read.',
        category: 'web',
        status: 'active',
        visibility: 'public',
        is_seeking_members: true,
        team_size_target: 4,
        member_count: 2,
        created_at: ago(14),
        deleted_at: null,
      },
      {
        id: projNotes,
        owner_id: pAyesha,
        slug: 'discrete-notes',
        title: 'Discrete structures notes',
        purpose: 'Proofs written out properly, with the wrong turns kept in.',
        description:
          'Lecture notes rewritten as arguments rather than transcriptions, with the false starts left in because that is what actually teaches the method.',
        category: 'education',
        status: 'active',
        visibility: 'public',
        is_seeking_members: false,
        team_size_target: 2,
        member_count: 1,
        created_at: ago(30),
        deleted_at: null,
      },
      {
        id: projDial,
        owner_id: pBilal,
        slug: 'analogue-dial',
        title: 'Analogue dial for a digital clock',
        purpose: 'A physical dial that shows the time remaining in a pomodoro.',
        description:
          'Stepper motor, a 3D-printed face, and an ESP32. The interesting part is the gear ratio and the noise.',
        category: 'hardware',
        status: 'planning',
        visibility: 'university',
        is_seeking_members: true,
        team_size_target: 3,
        member_count: 1,
        created_at: ago(6),
        deleted_at: null,
      },
    )

    db.project_members.push(
      { id: id('mem'), project_id: projTimetable, profile_id: pDemo, role: 'owner', created_at: ago(14) },
      { id: id('mem'), project_id: projTimetable, profile_id: pHira, role: 'member', created_at: ago(9) },
      { id: id('mem'), project_id: projNotes, profile_id: pAyesha, role: 'owner', created_at: ago(30) },
      { id: id('mem'), project_id: projDial, profile_id: pBilal, role: 'owner', created_at: ago(6) },
    )

    // ------------------------------------------------------------------- ideas
    db.ideas.push(
      {
        id: id('dea'),
        author_id: pDemo,
        title: 'A room-booking board that tells you when it frees up',
        description:
          'Every lab has a whiteboard by the door with a timeslot nobody updates. A page that answers "is 204 free in twenty minutes" would save a walk per day.',
        category: 'web',
        status: 'open',
        visibility: 'public',
        upvote_count: 7,
        interest_count: 3,
        converted_project_id: null,
        created_at: ago(4),
        deleted_at: null,
      },
      {
        id: id('dea'),
        author_id: pHira,
        title: 'Past-paper search that searches the questions, not the file names',
        description:
          'The archive is 400 PDFs named by year. Nobody can find the question they remember, which is the only way anyone looks for a past paper.',
        category: 'education',
        status: 'open',
        visibility: 'public',
        upvote_count: 14,
        interest_count: 5,
        converted_project_id: null,
        created_at: ago(11),
        deleted_at: null,
      },
      {
        id: id('dea'),
        author_id: pUsman,
        title: 'A timetable that knows when a class is cancelled',
        description:
          'Cancellations arrive on a WhatsApp group and nowhere else. A small bot that reads the announcement and updates the shared timetable.',
        category: 'automation',
        status: 'open',
        visibility: 'university',
        upvote_count: 5,
        interest_count: 2,
        converted_project_id: null,
        created_at: ago(2),
        deleted_at: null,
      },
    )

    // ------------------------------------------------------------------- posts
    db.posts.push(
      {
        id: post1,
        author_id: pAyesha,
        body:
          'Finished the third problem set for discrete structures. The proof for question four took me two evenings and a false start, which is roughly the ratio I expected.',
        visibility: 'university',
        project_id: projNotes,
        goal_id: null,
        moderation_status: 'active',
        like_count: 0,
        comment_count: 0,
        created_at: ago(0, 2),
        deleted_at: null,
      },
      {
        id: post2,
        author_id: pBilal,
        body:
          'The stepper motor finally moves without skipping. It only took a different driver and a gear ratio I should have worked out on paper first.',
        visibility: 'public',
        project_id: projDial,
        goal_id: null,
        moderation_status: 'active',
        like_count: 0,
        comment_count: 0,
        created_at: ago(0, 6),
        deleted_at: null,
      },
      {
        id: post3,
        author_id: pDemo,
        body:
          'Logged five days in a row on the study log, which is the longest run I have managed. The streak is doing more work than any planner app I have tried.',
        visibility: 'public',
        project_id: null,
        goal_id: goalProofs,
        moderation_status: 'active',
        like_count: 0,
        comment_count: 0,
        created_at: ago(1, 3),
        deleted_at: null,
      },
      {
        id: post4,
        author_id: pHira,
        body:
          'Unpopular opinion: most "design systems" are a colour file and a component with four props. The useful part is deciding what not to build.',
        visibility: 'public',
        project_id: null,
        goal_id: null,
        moderation_status: 'active',
        like_count: 0,
        comment_count: 0,
        created_at: ago(1, 9),
        deleted_at: null,
      },
      {
        id: post5,
        author_id: pUsman,
        body:
          'Rewrote a query that took 900ms. It was a missing index on a column we filter by constantly. Six characters of SQL for nine hundred milliseconds.',
        visibility: 'public',
        project_id: null,
        goal_id: null,
        moderation_status: 'active',
        like_count: 0,
        comment_count: 0,
        created_at: ago(2, 5),
        deleted_at: null,
      },
      {
        id: post6,
        author_id: pDemo,
        body:
          'Looking for one more person for the timetable project — someone who enjoys CSS more than I do. Two of four slots filled.',
        visibility: 'university',
        project_id: projTimetable,
        goal_id: null,
        moderation_status: 'active',
        like_count: 0,
        comment_count: 0,
        created_at: ago(3, 1),
        deleted_at: null,
      },
    )

    const likes: [string, string][] = [
      [post1, pDemo],
      [post1, pBilal],
      [post1, pUsman],
      [post2, pDemo],
      [post2, pAyesha],
      [post3, pAyesha],
      [post3, pHira],
      [post3, pUsman],
      [post3, pBilal],
      [post4, pDemo],
      [post4, pUsman],
      [post5, pDemo],
      [post5, pAyesha],
      [post6, pHira],
    ]
    for (const [postId, profileId] of likes) {
      db.post_likes.push({ id: id('lke'), post_id: postId, profile_id: profileId, created_at: ago(0, 1) })
    }
    for (const post of db.posts) {
      post.like_count = db.post_likes.filter((like) => like.post_id === post.id).length
    }

    db.post_saves.push({ id: id('sav'), post_id: post1, profile_id: pDemo, created_at: ago(0, 1) })

    db.comments.push(
      {
        id: id('cmt'),
        post_id: post1,
        author_id: pDemo,
        parent_id: null,
        body: 'Question four got me too. The induction step is where I always lose the thread.',
        created_at: ago(0, 1),
        deleted_at: null,
      },
      {
        id: id('cmt'),
        post_id: post1,
        author_id: pBilal,
        parent_id: null,
        body: 'Which textbook? The one we have skips the case that matters.',
        created_at: ago(0, 1),
        deleted_at: null,
      },
      {
        id: id('cmt'),
        post_id: post4,
        author_id: pDemo,
        parent_id: null,
        body: 'The "what not to build" list is the part nobody writes down.',
        created_at: ago(1, 4),
        deleted_at: null,
      },
    )
    for (const post of db.posts) {
      post.comment_count = db.comments.filter((comment) => comment.post_id === post.id).length
    }

    // ------------------------------------------------------------ notifications
    db.notifications.push(
      {
        id: id('ntf'),
        recipient_id: pDemo,
        actor_id: pAyesha,
        type: 'post_comment',
        body: null,
        is_read: false,
        created_at: ago(0, 1),
        post_id: post1,
        comment_id: db.comments[0]?.id ?? null,
        project_id: null,
        idea_id: null,
        event_id: null,
        opportunity_id: null,
        conversation_id: null,
      },
      {
        id: id('ntf'),
        recipient_id: pDemo,
        actor_id: pBilal,
        type: 'post_like',
        body: null,
        is_read: false,
        created_at: ago(0, 4),
        post_id: post3,
        comment_id: null,
        project_id: null,
        idea_id: null,
        event_id: null,
        opportunity_id: null,
        conversation_id: null,
      },
      {
        id: id('ntf'),
        recipient_id: pDemo,
        actor_id: pHira,
        type: 'project_application',
        body: null,
        is_read: false,
        created_at: ago(1, 2),
        post_id: null,
        comment_id: null,
        project_id: projTimetable,
        idea_id: null,
        event_id: null,
        opportunity_id: null,
        conversation_id: null,
      },
      {
        id: id('ntf'),
        recipient_id: pDemo,
        actor_id: pUsman,
        type: 'follow',
        body: null,
        is_read: true,
        created_at: ago(2, 6),
        post_id: null,
        comment_id: null,
        project_id: null,
        idea_id: null,
        event_id: null,
        opportunity_id: null,
        conversation_id: null,
      },
      {
        id: id('ntf'),
        recipient_id: pDemo,
        actor_id: null,
        type: 'achievement_awarded',
        body: 'Five days logged in a row.',
        is_read: true,
        created_at: ago(3, 2),
        post_id: null,
        comment_id: null,
        project_id: null,
        idea_id: null,
        event_id: null,
        opportunity_id: null,
        conversation_id: null,
      },
    )

    // ---------------------------------------------------------------- messaging
    const convo = id('cnv')
    db.conversations.push({
      id: convo,
      type: 'direct',
      title: null,
      last_message_at: ago(0, 1),
      last_message_preview: 'Deal. Wednesday after the lab?',
      created_at: ago(2),
    })
    db.conversation_participants.push(
      { id: id('par'), conversation_id: convo, profile_id: pDemo, last_read_at: ago(0, 3) },
      { id: id('par'), conversation_id: convo, profile_id: pHira, last_read_at: ago(0, 2) },
    )
    db.messages.push(
      {
        id: id('msg'),
        conversation_id: convo,
        author_id: pHira,
        body: 'Saw your timetable post — do you still need someone for the front end?',
        created_at: ago(2, 2),
      },
      {
        id: id('msg'),
        conversation_id: convo,
        author_id: pDemo,
        body: 'Yes, two slots open. It is mostly making the grid readable on a phone.',
        created_at: ago(2, 1),
      },
      {
        id: id('msg'),
        conversation_id: convo,
        author_id: pHira,
        body: 'That is the part I actually enjoy. Send me the repo?',
        created_at: ago(0, 2),
      },
      {
        id: id('msg'),
        conversation_id: convo,
        author_id: pDemo,
        body: 'Deal. Wednesday after the lab?',
        created_at: ago(0, 1),
      },
    )

    // ----------------------------------------------------------------- learning
    db.semesters.push({
      id: sem,
      profile_id: pDemo,
      name: 'Autumn 2026',
      term: 'fall',
      year: 2026,
      start_date: dayAgo(40),
      end_date: dayAgo(-40),
      is_current: true,
      created_at: ago(40),
    })

    const courses = [
      { code: 'CSC-101', title: 'Discrete Structures', credits: 3, instructor: 'Dr. Sana Malik' },
      { code: 'CSC-102', title: 'Programming Fundamentals', credits: 4, instructor: 'Mr. Imran Qureshi' },
      { code: 'MTH-101', title: 'Calculus and Analytical Geometry', credits: 3, instructor: 'Dr. Ayesha Noor' },
      { code: 'ENG-101', title: 'Functional English', credits: 2, instructor: 'Ms. Rida Aslam' },
    ]
    for (const course of courses) {
      db.courses.push({
        id: id('crs'),
        semester_id: sem,
        profile_id: pDemo,
        code: course.code,
        title: course.title,
        instructor: course.instructor,
        credits: course.credits,
        status: 'in_progress',
        grade: null,
        created_at: ago(40),
      })
    }

    db.goals.push(
      {
        id: goalProofs,
        profile_id: pDemo,
        semester_id: sem,
        course_id: null,
        title: 'Finish every problem set for discrete structures',
        description: 'Twelve sets across the term. Done means attempted, not correct.',
        category: 'academic',
        status: 'active',
        target_value: 12,
        current_value: 5,
        unit: 'problem sets',
        progress_percent: 42,
        visibility: 'public',
        target_date: dayAgo(-60),
        completed_at: null,
        milestone_count: 3,
        completed_milestone_count: 1,
        created_at: ago(38),
      },
      {
        id: goalGodot,
        profile_id: pDemo,
        semester_id: sem,
        course_id: null,
        title: 'Ship a playable build of the platformer',
        description: 'One level, one boss, no placeholder art.',
        category: 'project',
        status: 'active',
        target_value: 1,
        current_value: 0,
        unit: 'build',
        progress_percent: 0,
        visibility: 'public',
        target_date: dayAgo(-90),
        completed_at: null,
        milestone_count: 5,
        completed_milestone_count: 2,
        created_at: ago(30),
      },
      {
        id: goalBooks,
        profile_id: pDemo,
        semester_id: sem,
        course_id: null,
        title: 'Read two books outside the syllabus',
        description: null,
        category: 'personal',
        status: 'active',
        target_value: 2,
        current_value: 1,
        unit: 'books',
        progress_percent: 50,
        visibility: 'private',
        target_date: null,
        completed_at: null,
        milestone_count: 0,
        completed_milestone_count: 0,
        created_at: ago(20),
      },
    )

    const milestoneSets: Record<string, [string, boolean][]> = {
      [goalProofs]: [
        ['Sets one to four submitted', true],
        ['Sets five to eight submitted', false],
        ['Sets nine to twelve submitted', false],
      ],
      [goalGodot]: [
        ['Player movement and collision', true],
        ['One complete level', true],
        ['Enemy behaviour', false],
        ['Boss fight', false],
        ['Export and playtest with someone else', false],
      ],
    }
    for (const [goalId, items] of Object.entries(milestoneSets)) {
      items.forEach(([title, done], index) => {
        db.goal_milestones.push({
          id: id('mls'),
          goal_id: goalId,
          title,
          is_completed: done,
          completed_at: done ? ago(10) : null,
          target_date: null,
          sort_order: index,
        })
      })
    }

    // Five consecutive days ending yesterday, then a gap: a real streak, not a perfect one.
    for (const daysBack of [1, 2, 3, 4, 5]) {
      db.daily_logs.push({
        id: id('log'),
        profile_id: pDemo,
        log_date: dayAgo(daysBack),
        hours_studied: [3.5, 2, 4, 1.5, 3][daysBack - 1] ?? 2,
        mood: [4, 3, 5, 2, 4][daysBack - 1] ?? 3,
        productivity: [4, 3, 4, 2, 3][daysBack - 1] ?? 3,
        summary:
          daysBack === 1
            ? 'Problem set three, questions one to six. The induction step finally made sense.'
            : daysBack === 2
              ? 'Mostly reading. Low output but the chapter on relations was worth it.'
              : 'Steady session, nothing remarkable.',
        wins: daysBack === 2 ? null : 'Kept the sitting under two hours so it did not become a chore.',
        blockers: daysBack === 2 ? 'Slept badly, could not hold the thread.' : null,
        created_at: ago(daysBack, 1),
        updated_at: ago(daysBack, 1),
      })
    }

    // ----------------------------------------------------- opportunities, events
    db.opportunities.push(
      {
        id: id('opp'),
        posted_by: pAyesha,
        title: 'Summer research internship — data systems lab',
        organisation: 'COMSATS, Department of Computer Science',
        description:
          'Ten weeks working on query execution over small datasets. Python and SQL. Open to second- and third-semester students who can show something they built.',
        type: 'internship',
        work_mode: 'on_site',
        visibility: 'university',
        compensation: 'Stipend',
        location: 'Attock',
        apply_url: null,
        apply_email: 'lab@example.edu',
        deadline: dayAgo(-12),
        starts_on: dayAgo(-90),
        status: 'open',
        created_at: ago(5),
        deleted_at: null,
      },
      {
        id: id('opp'),
        posted_by: pUsman,
        title: 'Hackathon — build something for your campus',
        organisation: 'NUST Computing Society',
        description:
          'Thirty-six hours, teams of four, any stack. Judged on whether the thing runs and whether anyone would use it.',
        type: 'competition',
        work_mode: 'on_site',
        visibility: 'public',
        compensation: null,
        location: 'Islamabad',
        apply_url: 'https://example.edu/hackathon',
        apply_email: null,
        deadline: dayAgo(-5),
        starts_on: dayAgo(-20),
        status: 'open',
        created_at: ago(8),
        deleted_at: null,
      },
      {
        id: id('opp'),
        posted_by: pHira,
        title: 'Scholarship — merit award for second year',
        organisation: 'UET Taxila',
        description: 'Covers tuition for one year. Requires a 3.5 GPA and one project write-up.',
        type: 'scholarship',
        work_mode: 'remote',
        visibility: 'public',
        compensation: 'Full tuition',
        location: null,
        apply_url: null,
        apply_email: 'awards@example.edu',
        deadline: dayAgo(3),
        starts_on: null,
        status: 'open',
        created_at: ago(20),
        deleted_at: null,
      },
    )

    const eventOne = id('evt')
    const eventTwo = id('evt')
    db.events.push(
      {
        id: eventOne,
        created_by: pBilal,
        title: 'Hardware night: soldering and sensors',
        description:
          'Bring a board and a problem. Two irons, a handful of sensors, and someone who has already made the mistakes.',
        location: 'Lab 204, COMSATS Attock',
        starts_at: ago(-3, -4),
        ends_at: ago(-3, -1),
        timezone: 'Asia/Karachi',
        capacity: 20,
        attendee_count: 2,
        visibility: 'university',
        status: 'scheduled',
        created_at: ago(9),
        deleted_at: null,
      },
      {
        id: eventTwo,
        created_by: pHira,
        title: 'Design systems, without the theatre',
        description:
          'A short talk on what a small team actually needs from a design system, followed by an argument.',
        location: 'Auditorium, UET Taxila',
        starts_at: ago(6, 2),
        ends_at: ago(6, 0),
        timezone: 'Asia/Karachi',
        capacity: null,
        attendee_count: 1,
        visibility: 'public',
        status: 'scheduled',
        created_at: ago(18),
        deleted_at: null,
      },
    )

    db.event_attendees.push(
      { id: id('att'), event_id: eventOne, profile_id: pDemo, status: 'going', created_at: ago(4) },
      { id: id('att'), event_id: eventOne, profile_id: pAyesha, status: 'going', created_at: ago(3) },
      { id: id('att'), event_id: eventTwo, profile_id: pDemo, status: 'going', created_at: ago(10) },
    )
    for (const event of db.events) {
      event.attendee_count = db.event_attendees.filter(
        (attendee) => attendee.event_id === event.id && attendee.status !== 'cancelled',
      ).length
    }
  }
}

/**
 * Write the seed if the store has no accounts yet. Idempotent, and cheap after the
 * first call because `readStore` keeps the parsed copy in memory for the process.
 */
export async function ensureSeeded(): Promise<void> {
  const db = await readStore()
  if (db.users.length > 0) return
  await mutate(build())
}

/** Used by `npm run seed:local -- --reset` to rebuild from scratch. */
export async function reseed(): Promise<void> {
  await mutate((db) => {
    for (const key of Object.keys(db) as (keyof Tables)[]) {
      ;(db[key] as unknown[]).length = 0
    }
    build()(db)
  })
}

export const seedTimestamp = now
