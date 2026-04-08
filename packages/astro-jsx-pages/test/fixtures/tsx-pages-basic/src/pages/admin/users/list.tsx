export const prerender = true;

export default function UsersListPage() {
  const users = ['Alice', 'Bob', 'Charlie'];

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Users List</title>
      </head>
      <body>
        <h1>Admin - Users List</h1>
        <ul>
          {users.map((user) => (
            <li key={user}>{user}</li>
          ))}
        </ul>
      </body>
    </html>
  );
}
