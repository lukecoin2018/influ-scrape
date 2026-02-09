interface StatusBadgeProps {
    status: string;
  }
  
  export default function StatusBadge({ status }: StatusBadgeProps) {
    const colors = {
      active: 'bg-green-100 text-green-800',
      archived: 'bg-gray-100 text-gray-800',
      flagged: 'bg-yellow-100 text-yellow-800',
      rejected: 'bg-red-100 text-red-800',
    };
  
    const color = colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
        {status}
      </span>
    );
  }