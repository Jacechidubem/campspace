export const STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta',
  'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi',
  'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara',
];

// Accommodation needs a medical officer can approve. The first three change which bunks are bookable.
export const NEEDS = {
  ground_floor: 'Ground-floor room',
  lower_bunk: 'Lower bunk',
  wheelchair_access: 'Wheelchair / step-free access',
  near_restroom: 'Close to restrooms',
  power_access: 'Power outlet at bunk (medical device)',
  quiet_room: 'Quiet, low-disturbance room',
  observation: 'Close to the camp clinic',
};

export const MEDICAL_CATEGORIES = [
  'Mobility or injury', 'Chronic illness', 'Respiratory', 'Cardiovascular', 'Neurological',
  'Post-surgery recovery', 'Vision or hearing', 'Mental health', 'Other',
];

export const PERMISSIONS = {
  'booking.own': 'Book, change, cancel and view own accommodation',
  'medical.request': 'Submit and track own medical accommodation requests',
  'hostels.view': 'View hostels, rooms and bunk availability',
  'hostels.manage': 'Create and edit hostels, rooms and bunks',
  'bookings.view': 'View all bookings in the camp',
  'bookings.manage': 'Assign, move and cancel bookings; manage the waiting list',
  'checkin.manage': 'Verify QR tickets and check corps members in',
  'corps.verify': 'Verify corps members’ NYSC call-up numbers',
  'medical.instructions': 'See approved medical accommodation instructions (never diagnoses)',
  'medical.review': 'Read medical records, assess requests and set priority',
  'reports.camp': 'View camp reports and analytics',
  'reports.system': 'View cross-camp system reports',
  'users.manage': 'Create and manage user accounts',
  'roles.manage': 'Edit role permissions',
  'camps.manage': 'Create and manage camps',
  'config.manage': 'Edit system configuration',
  'audit.view': 'View and verify audit logs',
};

export const DEFAULT_ROLE_PERMISSIONS = {
  corps_member: ['booking.own', 'medical.request', 'hostels.view'],
  accommodation_officer: [
    'hostels.view', 'hostels.manage', 'bookings.view', 'bookings.manage', 'checkin.manage',
    'corps.verify', 'medical.instructions', 'reports.camp',
  ],
  medical_personnel: ['medical.review', 'reports.camp'],
  super_admin: [
    'hostels.view', 'hostels.manage', 'bookings.view', 'bookings.manage', 'checkin.manage', 'corps.verify',
    'medical.instructions', 'reports.camp', 'reports.system', 'users.manage', 'roles.manage', 'camps.manage',
    'config.manage', 'audit.view',
  ],
};

export const ROLES = ['corps_member', 'accommodation_officer', 'medical_personnel', 'super_admin'];
export const ROLE_LABELS = {
  corps_member: 'Corps member',
  accommodation_officer: 'Accommodation officer',
  medical_personnel: 'Medical personnel',
  super_admin: 'Super administrator',
};

export const DEFAULT_CONFIG = {
  registration_open: 'true',
  require_verified_to_book: 'false',
  allow_self_cancel: 'true',
  max_self_cancellations: '2',
  waitlist_auto_promote: 'true',
  session_hours: '12',
  support_email: 'support@campspace.example',
  support_phone: '+234 800 000 0000',
  announcement: '',
};
