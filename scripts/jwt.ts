import jwt from 'jsonwebtoken';
const secret = "vVulB1AbCO2iUb2Oapchq5hhNcoM7rASdULQk7-w26g"; // The secret part of the JWT
const token = jwt.sign({
  role: 'authenticated',
  uid: 'e0fa42d3-eebd-4247-acf4-ef11039c781a',
  sub: 'e0fa42d3-eebd-4247-acf4-ef11039c781a',
  aud: 'authenticated',
  iss: 'supabase'
}, 'vVulB1AbCO2iUb2Oapchq5hhNcoM7rASdULQk7-w26g', { expiresIn: '1h' });

console.log(token);
