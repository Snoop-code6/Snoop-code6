import nodemailer from 'nodemailer';

// SMTP_URL, ex. smtps://utilisateur:motdepasse@smtp.fournisseur.fr:465
export function createMailer({ url, from }) {
  const transport = nodemailer.createTransport(url, { disableFileAccess: true, disableUrlAccess: true });
  return {
    send: ({ to, subject, text, html }) => transport.sendMail({ from, to, subject, text, html }),
    verify: () => transport.verify(),
  };
}
